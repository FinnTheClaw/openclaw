/** Host-owned bridge between the durable governor and the production agent loop. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import { createGovernorEffectId } from "../tasks/governor/types.js";
import {
  validateGovernorAgentLoopConfiguration,
  type GovernorAgentLoopConfiguration,
  type GovernorAgentLoopMode,
} from "./governor-agent-loop-config.js";
import {
  ensureGovernorAgentLoopExecuting,
  interruptGovernorAgentLoopTool,
  recordGovernorAgentLoopToolObservation,
  type GovernorAgentLoopTicketState,
} from "./governor-agent-loop-task.js";
import {
  createGovernorAgentLoopTool,
  governorAgentLoopToolImplementationDigest,
  matchesHostGovernorAgentLoopTool,
} from "./governor-agent-loop-tools.js";
import {
  governorAgentLoopTopLevelString,
  safeGovernorAgentLoopValue,
} from "./governor-agent-loop-values.js";
import type { HostGovernorCapabilities } from "./governor-host-contracts.js";
export type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";

export type GovernorAgentLoopRunInput = Readonly<{
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  channel: string;
  accountId: string;
  principalId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceSequence?: number;
  prompt: string;
  now: number;
}>;

export type GovernorAgentLoopToolTicket = Readonly<{ opaque: object }>;
export type GovernorAgentLoopToolDecision =
  | { kind: "allow"; ticket?: GovernorAgentLoopToolTicket }
  | { kind: "block"; reasonCode: string };
export type GovernorAgentLoopTurnDecision =
  | { kind: "complete" }
  | { kind: "continue"; message: string }
  | { kind: "stop"; reasonCode: string };

export type GovernorAgentLoopRunScope = Readonly<{
  taskId: string;
  mode: GovernorAgentLoopMode;
  beforeTool(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    tool: import("../../packages/agent-core/src/types.js").AgentTool | undefined;
    now: number;
  }): GovernorAgentLoopToolDecision;
  afterTool(input: {
    ticket?: GovernorAgentLoopToolTicket;
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
    now: number;
  }): void;
  afterTurn(input: {
    assistantText: string;
    assistantStopReason?: string;
    toolCallCount: number;
    now: number;
  }): GovernorAgentLoopTurnDecision;
  interrupt(input: { now: number }): void;
  assertTerminal(): void;
  governedTools(): readonly import("../../packages/agent-core/src/types.js").AgentTool[];
  dispose(): void;
}>;

type ActiveHost = Readonly<{
  config: GovernorAgentLoopConfiguration;
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
}>;

const RUN_SCOPES = new WeakSet<object>();
const TICKETS = new WeakMap<object, GovernorAgentLoopTicketState>();
let activeHost: ActiveHost | undefined;

function createScope(
  host: ActiveHost,
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope {
  const promptDigest = governorDigest(input.prompt);
  const definitions = host.config.toolBindings.map((binding) =>
    host.controller.capabilities.definition(binding.capability),
  );
  if (definitions.some((item) => !item)) {
    throw new Error("GOVERNOR_AGENT_LOOP_CAPABILITY_UNKNOWN");
  }
  const contract = {
    objective: `Complete host-governed agent request ${promptDigest.slice(0, 16)}`,
    constraints: [
      "Use only host-authorized capabilities",
      "Completion requires current admitted evidence",
    ],
    knownFacts: [],
    unknowns: host.config.criteria.map((item) => item.criterionId),
    completionCriteria: host.config.criteria.map((item) => ({ ...item, mandatory: true })),
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: definitions
        .filter((item) => item?.mutating)
        .map((item) => item!.capability),
      canonicalTargets: host.config.toolBindings
        .filter((_, index) => definitions[index]?.mutating)
        .map((item) => item.canonicalTarget),
    },
  };
  const ingress: Omit<Parameters<GovernorController["ingest"]>[0], "sourceSequence"> = {
    sourceMessageId: input.sourceMessageId,
    scope: {
      principalId: input.principalId,
      channel: input.channel,
      accountId: input.accountId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    },
    mode: host.config.criteria.length > 12 ? "DEEP" : "FOCUSED",
    profile: {
      incident: false,
      effectful: definitions.some((item) => item?.mutating),
      requiresExternalEvidence: host.config.criteria.length > 0,
      consequential: true,
      estimatedUsefulActions: host.config.criteria.length,
      independentBranches: 0,
    },
    contract,
    flowId: input.runId,
    now: input.now,
  };
  const route =
    input.sourceSequence === undefined
      ? host.controller.ingestHostSequenced(ingress)
      : host.controller.ingest({ ...ingress, sourceSequence: input.sourceSequence });
  if (route.kind === "stale") {
    throw new Error("GOVERNOR_AGENT_LOOP_STALE_INGRESS");
  }
  const taskId = route.task.taskId;
  ensureGovernorAgentLoopExecuting(host.controller, taskId, input.now + 1);
  let turns = 0;
  let terminal = route.task.state === "COMPLETED";
  let terminalReason: string | undefined;
  const governedTools = Object.freeze(
    host.config.toolBindings.map((binding) =>
      createGovernorAgentLoopTool({
        toolName: binding.toolName,
        implementationId: binding.implementationId,
      }),
    ),
  );
  const governedToolsByName = new Map(governedTools.map((tool) => [tool.name, tool]));
  const pendingTickets = new Set<object>();

  const scope: GovernorAgentLoopRunScope = Object.freeze({
    taskId,
    mode: host.config.mode,
    beforeTool(request) {
      const binding = host.config.toolBindings.find((item) => item.toolName === request.toolName);
      if (!binding) {
        if (host.config.mode === "shadow") {
          host.controller.recordRuntimeEvent({
            taskId,
            eventType: "runtime_tool_proposed",
            payload: { toolName: request.toolName, mode: "shadow", binding: "unconfigured" },
            now: request.now,
          });
          return { kind: "allow" };
        }
        return { kind: "block", reasonCode: "GOVERNOR_TOOL_NOT_BOUND" };
      }
      const args = safeGovernorAgentLoopValue(request.args);
      if (host.config.mode === "shadow") {
        host.controller.recordRuntimeEvent({
          taskId,
          eventType: "runtime_tool_proposed",
          payload: {
            toolName: binding.toolName,
            argumentsDigest: governorDigest(args),
            mode: "shadow",
          },
          now: request.now,
        });
        return { kind: "allow" };
      }
      if (
        !request.tool ||
        request.tool !== governedToolsByName.get(binding.toolName) ||
        !matchesHostGovernorAgentLoopTool(request.tool, {
          toolName: binding.toolName,
          implementationId: binding.implementationId,
        })
      ) {
        return { kind: "block", reasonCode: "GOVERNOR_TOOL_IMPLEMENTATION_MISMATCH" };
      }
      const definition = host.controller.capabilities.definition(binding.capability);
      if (!definition) {
        return { kind: "block", reasonCode: "GOVERNOR_CAPABILITY_UNAVAILABLE" };
      }
      const task = ensureGovernorAgentLoopExecuting(host.controller, taskId, request.now);
      const observationKey = governorAgentLoopTopLevelString(args, binding.criterionArgument);
      const criterionId =
        binding.criterionId ??
        (observationKey && binding.criteriaByValue
          ? binding.criteriaByValue[observationKey]
          : undefined);
      const effectDigest = governorDigest({
        taskId,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        executionGeneration: task.executionGeneration,
        toolName: binding.toolName,
        toolImplementationDigest: governorAgentLoopToolImplementationDigest(
          binding.implementationId,
        ),
        argumentsDigest: governorDigest(args),
      });
      const admission = host.controller.admitAction({
        taskId,
        executionFence: host.controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId(`loop_${effectDigest.slice(0, 40)}`),
          ...(criterionId ? { criterionId } : {}),
          capability: definition.capability,
          capabilityVersion: definition.version,
          canonicalTarget: binding.canonicalTarget,
          expectedEvidence: "Host-observed tool outcome digest",
          sourceRank: definition.sourceRank,
          stopCondition: criterionId ? `criterion:${criterionId}` : "tool outcome recorded",
          mutating: definition.mutating,
          argumentsDigest: governorDigest(args),
          toolImplementationDigest: governorAgentLoopToolImplementationDigest(
            binding.implementationId,
          ),
          ...(governorAgentLoopTopLevelString(args, binding.approvalGrantArgument)
            ? {
                approvalGrantId: governorAgentLoopTopLevelString(
                  args,
                  binding.approvalGrantArgument,
                )!,
              }
            : {}),
        },
        progressVector: { toolName: binding.toolName, observationKey: observationKey ?? "none" },
        now: request.now,
      });
      if (!admission.accepted) {
        return { kind: "block", reasonCode: "GOVERNOR_STALE_EXECUTION" };
      }
      const workerId = `loop_${governorDigest([input.runId, request.toolCallId]).slice(0, 32)}`;
      const claim = host.controller.claimActionIntent({
        intent: admission.intent,
        workerId,
        now: request.now,
      });
      if (claim.kind !== "claimed") {
        return claim.kind === "completed"
          ? { kind: "block", reasonCode: "GOVERNOR_DUPLICATE_TOOL_CALL" }
          : { kind: "block", reasonCode: "GOVERNOR_ACTION_NOT_CLAIMED" };
      }
      const started = host.controller.beginActionEffect({
        intent: claim.intent,
        workerId,
        claimEpoch: claim.intent.claimEpoch,
        now: request.now,
      });
      const resumedReadOnly =
        started.kind === "reconcile_required" &&
        !started.intent.proposal.mutating &&
        started.intent.claimedBy === workerId &&
        started.intent.claimEpoch === claim.intent.claimEpoch;
      if (started.kind !== "started" && !resumedReadOnly) {
        return { kind: "block", reasonCode: "GOVERNOR_EFFECT_NOT_STARTED" };
      }
      const runningIntent = started.intent;
      const opaque = Object.freeze({});
      TICKETS.set(opaque, {
        intent: runningIntent,
        workerId,
        claimEpoch: runningIntent.claimEpoch,
        toolCallId: request.toolCallId,
        toolName: binding.toolName,
        ...(criterionId ? { criterionId } : {}),
        ...(observationKey ? { observationKey } : {}),
      });
      pendingTickets.add(opaque);
      return { kind: "allow", ticket: Object.freeze({ opaque }) };
    },
    afterTool(observation) {
      if (host.config.mode === "shadow") {
        host.controller.recordRuntimeEvent({
          taskId,
          eventType: "runtime_tool_observed",
          payload: {
            toolName: observation.toolName,
            resultDigest: governorDigest(safeGovernorAgentLoopValue(observation.result)),
            isError: observation.isError,
          },
          now: observation.now,
        });
        return;
      }
      const state = observation.ticket ? TICKETS.get(observation.ticket.opaque) : undefined;
      if (!state) {
        throw new Error("GOVERNOR_AGENT_LOOP_TICKET_INVALID");
      }
      if (observation.toolCallId !== state.toolCallId || observation.toolName !== state.toolName) {
        throw new Error("GOVERNOR_AGENT_LOOP_OBSERVATION_BINDING_MISMATCH");
      }
      recordGovernorAgentLoopToolObservation({
        controller: host.controller,
        submitObservedReceipt: host.submitObservedReceipt,
        taskId,
        state,
        observation: {
          toolName: observation.toolName,
          result: observation.result,
          isError: observation.isError,
          now: observation.now,
        },
      });
      pendingTickets.delete(observation.ticket!.opaque);
      TICKETS.delete(observation.ticket!.opaque);
    },
    afterTurn(turn) {
      turns += 1;
      host.controller.recordRuntimeEvent({
        taskId,
        eventType: "runtime_model_turn_recorded",
        payload: {
          turn: turns,
          assistantTextDigest: governorDigest(turn.assistantText),
          toolCallCount: turn.toolCallCount,
          stopReason: turn.assistantStopReason ?? "unknown",
        },
        now: turn.now,
      });
      if (host.config.mode === "shadow") {
        if (turn.toolCallCount === 0) {
          host.controller.recordRuntimeEvent({
            taskId,
            eventType: "runtime_finish_proposed",
            payload: { mode: "shadow", turn: turns },
            now: turn.now + 1,
          });
        }
        return { kind: "complete" };
      }
      if (turn.toolCallCount > 0) {
        return { kind: "continue", message: "" };
      }
      const responseDigestMatches =
        !host.config.expectedAssistantTextDigest ||
        governorDigest(turn.assistantText.trim()) === host.config.expectedAssistantTextDigest;
      const decision = host.controller.assessFinish({
        taskId,
        response: { framing: "none", materialClaimIds: [] },
        now: turn.now + 1,
      });
      host.controller.recordRuntimeEvent({
        taskId,
        eventType: "runtime_finish_proposed",
        payload: {
          acceptedByEvidence: decision.accepted,
          responseDigestMatches,
          turn: turns,
        },
        now: turn.now + 2,
      });
      if (decision.accepted && responseDigestMatches) {
        host.controller.beginVerification(taskId, turn.now + 3);
        const finished = host.controller.proposeFinish({
          taskId,
          response: { framing: "none", materialClaimIds: [] },
          now: turn.now + 4,
        });
        terminal = finished.completed;
        if (terminal) {
          return { kind: "complete" };
        }
      }
      if (turns >= host.config.maxTurns) {
        terminalReason = "GOVERNOR_AGENT_LOOP_BUDGET_EXHAUSTED";
        return { kind: "stop", reasonCode: terminalReason };
      }
      const unmet = decision.accepted ? ["response"] : decision.recovery.unmetCriteria;
      return {
        kind: "continue",
        message: `Governor continuation required. Remaining criteria: ${unmet.join(", ") || "verification"}.`,
      };
    },
    interrupt(interruption) {
      for (const opaque of [...pendingTickets]) {
        const state = TICKETS.get(opaque);
        if (!state) {
          pendingTickets.delete(opaque);
          continue;
        }
        interruptGovernorAgentLoopTool({
          controller: host.controller,
          taskId,
          state,
          now: interruption.now,
        });
        pendingTickets.delete(opaque);
        TICKETS.delete(opaque);
      }
      if (host.controller.store.loadTask(taskId)?.state === "EXECUTING") {
        host.controller.requestRuntimeReplan(taskId, interruption.now + 1);
      }
    },
    assertTerminal() {
      if (host.config.mode === "enforce" && !terminal) {
        throw new Error(terminalReason ?? "GOVERNOR_AGENT_LOOP_INCOMPLETE");
      }
    },
    governedTools() {
      return governedTools;
    },
    dispose() {
      pendingTickets.clear();
    },
  });
  RUN_SCOPES.add(scope);
  return scope;
}

/** Trusted bootstrap-only activation. The returned closure removes this exact host. */
export function installGovernorAgentLoopHost(params: {
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
  capabilities: readonly GovernorCapabilityDefinition[];
  config: GovernorAgentLoopConfiguration;
}): () => void {
  if (activeHost) {
    throw new Error("GOVERNOR_AGENT_LOOP_HOST_ALREADY_ACTIVE");
  }
  const host = Object.freeze({
    controller: params.controller,
    submitObservedReceipt: params.submitObservedReceipt,
    config: validateGovernorAgentLoopConfiguration(params.config, params.capabilities),
  });
  activeHost = host;
  return () => {
    if (activeHost === host) {
      activeHost = undefined;
    }
  };
}

/** Read-only resolution used by the production run seam. */
export function resolveHostGovernorAgentLoopScope(
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope | undefined {
  const host = activeHost;
  if (!host) {
    return undefined;
  }
  const selected = host.config.scopes.some(
    (scope) =>
      scope.sessionKey === input.sessionKey && (!scope.agentId || scope.agentId === input.agentId),
  );
  if (!selected) {
    return undefined;
  }
  try {
    return createScope(host, input);
  } catch (error) {
    if (host.config.mode === "shadow") {
      return undefined;
    }
    throw error;
  }
}

export function isHostIssuedGovernorAgentLoopScope(scope: GovernorAgentLoopRunScope): boolean {
  return RUN_SCOPES.has(scope);
}
