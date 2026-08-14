import {
  isGovernorAgentLoopRunScope,
  type GovernorAgentLoopRunScope,
  type GovernorAgentLoopToolTicket,
} from "../../security/governor-agent-loop-readonly.js";
/** Installs a host-issued governor scope at the actual Agent tool/turn loop. */
import type {
  AfterToolCallResult,
  Agent,
  AgentEvent,
  AgentMessage,
  BeforeToolCallResult,
} from "../runtime/index.js";

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function assistantStopReason(message: AgentMessage): string | undefined {
  return message.role === "assistant" && "stopReason" in message ? message.stopReason : undefined;
}

function asThrownError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export type GovernorLoopBridge = Readonly<{
  assertTerminal(): void;
  dispose(): void;
}>;

export function installGovernorLoopBridge(params: {
  agent: Agent;
  scope: GovernorAgentLoopRunScope;
  now?: () => number;
}): GovernorLoopBridge {
  if (!isGovernorAgentLoopRunScope(params.scope)) {
    throw new Error("GOVERNOR_AGENT_LOOP_SCOPE_INVALID");
  }
  const now = params.now ?? Date.now;
  const tickets = new Map<string, GovernorAgentLoopToolTicket | undefined>();
  const priorBefore = params.agent.beforeToolCall;
  const priorAfter = params.agent.afterToolCall;
  const priorShouldStop = params.agent.shouldStopAfterTurn;
  let toolInventoryLease: Readonly<{ restore(): void }> | undefined;
  const governedTools = new Map(params.scope.governedTools().map((tool) => [tool.name, tool]));
  let governedInventory = params.agent.state.tools.slice();
  let inventoryMasked = false;
  let stoppedReason: string | undefined;
  let terminalRequested = false;
  const sameInventory = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length && left.every((tool, index) => tool === right[index]);
  const maskTools = () => {
    if (
      !toolInventoryLease ||
      inventoryMasked ||
      !sameInventory(params.agent.state.tools, governedInventory)
    ) {
      return;
    }
    params.agent.state.tools = [];
    inventoryMasked = true;
  };
  const restoreTools = () => {
    if (!toolInventoryLease || !inventoryMasked || params.agent.state.tools.length !== 0) {
      return;
    }
    params.agent.state.tools = governedInventory;
    inventoryMasked = false;
  };
  const refreshToolPhase = () => {
    const phase = params.scope.turnPhase();
    if (phase === "actions") {
      restoreTools();
    }
    return phase;
  };
  const shouldStopAfterTurn = async (
    context: Parameters<NonNullable<Agent["shouldStopAfterTurn"]>>[0],
  ) => {
    refreshToolPhase();
    if (terminalRequested) {
      return true;
    }
    return (await priorShouldStop?.(context)) === true;
  };
  const governorSteeringKey = "openclaw-governor-progress";
  if (params.scope.mode === "enforce") {
    const legacyTools = params.agent.state.tools.filter((tool) => !governedTools.has(tool.name));
    governedInventory = [...legacyTools, ...governedTools.values()];
    toolInventoryLease = params.agent.installToolInventory(governedInventory);
  }

  const beforeToolCall: NonNullable<Agent["beforeToolCall"]> = async (context, signal) => {
    refreshToolPhase();
    const prior = await priorBefore?.(context, signal);
    if (prior?.block) {
      return prior;
    }
    try {
      const decision = params.scope.beforeTool({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
        tool: context.tool,
        now: now(),
      });
      if (decision.kind === "block") {
        if (params.scope.mode === "shadow") {
          return prior;
        }
        return { block: true, reason: decision.reasonCode } satisfies BeforeToolCallResult;
      }
      tickets.set(context.toolCall.id, decision.ticket);
      return prior;
    } catch (error) {
      if (params.scope.mode === "shadow") {
        return prior;
      }
      throw error;
    }
  };

  const afterToolCall: NonNullable<Agent["afterToolCall"]> = async (context, signal) => {
    let priorResult: AfterToolCallResult | undefined;
    let priorThrew = false;
    let priorError: unknown;
    try {
      priorResult = (await priorAfter?.(context, signal)) as AfterToolCallResult | undefined;
    } catch (error) {
      priorThrew = true;
      priorError = error;
    }
    try {
      params.scope.afterTool({
        ticket: tickets.get(context.toolCall.id),
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        result: priorThrew
          ? {
              content: [{ type: "text", text: "GOVERNOR_POST_TOOL_HOOK_FAILED" }],
              details: null,
            }
          : {
              content: priorResult?.content ?? context.result.content,
              details: priorResult?.details ?? context.result.details ?? null,
            },
        isError: priorThrew ? true : (priorResult?.isError ?? context.isError),
        now: now(),
      });
    } catch (error) {
      if (params.scope.mode !== "shadow") {
        throw error;
      }
    } finally {
      tickets.delete(context.toolCall.id);
    }
    if (priorThrew) {
      // The legacy Agent loop preserves arbitrary hook throw values here.
      throw priorError;
    }
    return priorResult;
  };

  params.agent.beforeToolCall = beforeToolCall;
  params.agent.afterToolCall = afterToolCall;
  if (params.scope.mode === "enforce") {
    params.agent.shouldStopAfterTurn = shouldStopAfterTurn;
  }
  const unsubscribe = params.agent.subscribe(async (event: AgentEvent) => {
    if (event.type !== "turn_end") {
      return;
    }
    if (stoppedReason) {
      return;
    }
    try {
      const decision = params.scope.afterTurn({
        assistantText: assistantText(event.message),
        assistantStopReason: assistantStopReason(event.message),
        toolCallCount:
          event.message.role === "assistant" && Array.isArray(event.message.content)
            ? event.message.content.filter((item) => item.type === "toolCall").length
            : 0,
        now: now(),
      });
      if (params.scope.mode === "shadow") {
        return;
      }
      if (decision.kind === "continue" && decision.message) {
        if (decision.phase === "final_response") {
          maskTools();
        } else {
          restoreTools();
        }
        params.agent.steerKeyed(governorSteeringKey, {
          role: "user",
          content: [{ type: "text", text: decision.message }],
          timestamp: now(),
        });
      } else if (decision.kind === "stop") {
        stoppedReason = decision.reasonCode;
        params.agent.removeSteeringKey(governorSteeringKey);
        terminalRequested = true;
      } else if (decision.kind === "interrupt") {
        stoppedReason = decision.reasonCode;
        params.scope.interrupt({ now: now() });
      } else if (decision.kind === "complete") {
        terminalRequested = true;
        params.agent.removeSteeringKey(governorSteeringKey);
      }
    } catch (error) {
      if (params.scope.mode !== "shadow") {
        throw error;
      }
    }
  });

  let disposed = false;
  return Object.freeze({
    assertTerminal() {
      if (stoppedReason) {
        throw new Error(stoppedReason);
      }
      params.scope.assertTerminal();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      let interruptError: unknown;
      try {
        if (params.scope.mode !== "shadow" && !terminalRequested) {
          params.scope.interrupt({ now: now() });
        }
      } catch (error) {
        if (params.scope.mode !== "shadow") {
          interruptError = error;
        }
      }
      unsubscribe();
      if (params.agent.beforeToolCall === beforeToolCall) {
        params.agent.beforeToolCall = priorBefore;
      }
      if (params.agent.afterToolCall === afterToolCall) {
        params.agent.afterToolCall = priorAfter;
      }
      if (params.agent.shouldStopAfterTurn === shouldStopAfterTurn) {
        params.agent.shouldStopAfterTurn = priorShouldStop;
      }
      restoreTools();
      toolInventoryLease?.restore();
      tickets.clear();
      if (params.scope.mode === "enforce") {
        params.agent.removeSteeringKey(governorSteeringKey);
      }
      params.scope.dispose();
      if (interruptError) {
        throw asThrownError(interruptError, "GOVERNOR_AGENT_LOOP_INTERRUPT_FAILED");
      }
    },
  });
}
