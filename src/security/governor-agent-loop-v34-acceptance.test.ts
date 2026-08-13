import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "../../packages/agent-core/src/llm.js";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorAgentLoopTool } from "./governor-agent-loop-tools.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability: GovernorCapabilityDefinition = {
  capability: "v34.acceptance.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function environment(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "v34-acceptance-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "v34-acceptance-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "v34-acceptance-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "v34-acceptance-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "v34-acceptance-ledger-key",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "v34-acceptance-deployment",
  };
}

function start(stateDir: string) {
  return createGovernorHostRuntimeIfEnabled({
    env: environment(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "v34-acceptance-evidence-owner",
      approvalOwnerId: "v34-acceptance-approval-owner",
      deliveryOwnerId: "v34-acceptance-delivery-owner",
      ownerIngressOwnerId: "v34-acceptance-ingress-owner",
      childOwnerId: "v34-acceptance-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "v34-acceptance-owner-account",
          gatewayInstanceId: "v34-acceptance-owner-gateway",
          ownerPrincipal: "v34-acceptance-owner-principal",
          actions: ["repair"],
          scopeKeys: ["v34-acceptance-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "v34-acceptance-session" }],
        criteria: [{ criterionId: "alpha", description: "Verify alpha" }],
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: { alpha: "alpha" },
            implementationId: "disposable-observation-v1",
          },
        ],
        maxTurns: 4,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  });
}

function input() {
  return {
    runId: "v34-acceptance-run",
    sessionKey: "v34-acceptance-session",
    sessionId: "v34-acceptance-session-id",
    agentId: "v34-acceptance-agent",
    workspaceId: "v34-acceptance-workspace",
    channel: "v34-acceptance-channel",
    accountId: "v34-acceptance-account",
    principalId: "v34-acceptance-principal",
    conversationId: "v34-acceptance-conversation",
    sourceMessageId: "v34-acceptance-message",
    sourceSequence: 1,
    prompt: "verify alpha",
    now: 100,
  } as const;
}

afterEach(() => closeOpenClawStateDatabase());

describe("V34 acceptance boundaries", () => {
  it("emits a flat required enum for host-owned criterion arguments", () => {
    const tool = createGovernorAgentLoopTool({
      toolName: "observe",
      implementationId: "disposable-observation-v1",
      argumentName: "key",
      allowedArgumentValues: ["alpha", "beta"],
    });
    const property = (tool.parameters as { properties: Record<string, unknown> }).properties
      .key as {
      type?: string;
      enum?: string[];
      anyOf?: unknown;
    };
    expect(property.type).toBe("string");
    expect(property.enum).toEqual(["alpha", "beta"]);
    expect(property.anyOf).toBeUndefined();
  });

  it("treats provider error and abort as resumable interruption, not stagnation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-provider-interrupt-" },
      async (state) => {
        const runtime = start(state.stateDir);
        if (!runtime) {
          throw new Error("acceptance runtime missing");
        }
        const scope = resolveGovernorAgentLoopRunScope(input());
        if (!scope) {
          throw new Error("acceptance scope missing");
        }
        expect(
          scope.afterTurn({
            assistantText: "",
            assistantStopReason: "error",
            toolCallCount: 0,
            now: 101,
          }),
        ).toEqual({ kind: "interrupt", reasonCode: "GOVERNOR_AGENT_LOOP_PROVIDER_INTERRUPTED" });
        scope.interrupt({ now: 102 });
        scope.dispose();
        const task = runtime.adapter.controller.store.loadTask(scope.taskId as never);
        expect(task?.state).toBe("REPLAN_REQUIRED");
        expect(
          runtime.adapter.controller.store
            .listEvents(scope.taskId as never)
            .filter(
              (event) =>
                event.eventType === "runtime_replan_requested" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                !Array.isArray(event.payload) &&
                event.payload.guidanceOnly === true,
            ),
        ).toHaveLength(0);
        runtime.close();
      },
    );
  });

  it("maps a real Agent/provider abort through the bridge to resumable recovery", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-agent-abort-" },
      async (state) => {
        const runtime = start(state.stateDir);
        if (!runtime) {
          throw new Error("acceptance runtime missing");
        }
        let bridge: { dispose(): void } | undefined;
        try {
          const scope = resolveGovernorAgentLoopRunScope(input());
          if (!scope) {
            throw new Error("acceptance scope missing");
          }
          let providerStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            providerStarted = resolve;
          });
          const agent = new Agent({
            initialState: { model, tools: [] },
            streamFn: (_activeModel, _context, options) => {
              const stream = createAssistantMessageEventStream();
              providerStarted();
              options?.signal?.addEventListener(
                "abort",
                () => {
                  const aborted = {
                    ...assistant([]),
                    stopReason: "aborted" as const,
                  } as unknown as AssistantMessage;
                  stream.push({
                    type: "done",
                    reason: "aborted",
                    message: aborted,
                  } as unknown as Parameters<typeof stream.push>[0]);
                  stream.end();
                },
                { once: true },
              );
              return stream;
            },
          });
          bridge = installGovernorLoopBridge({ agent, scope, now: () => 200 });
          const prompt = agent.prompt("provider abort");
          await started;
          agent.abort();
          await prompt;
          expect(runtime.adapter.controller.store.loadTask(scope.taskId as never)?.state).toBe(
            "REPLAN_REQUIRED",
          );
          const interruptions = runtime.adapter.controller.store
            .listEvents(scope.taskId as never)
            .filter(
              (event) =>
                event.eventType === "runtime_replan_requested" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                !Array.isArray(event.payload) &&
                event.payload.reasonCode === "provider_interrupted",
            );
          expect(interruptions).toHaveLength(1);
          expect(
            runtime.adapter.controller.store
              .listEvents(scope.taskId as never)
              .some(
                (event) =>
                  event.eventType === "runtime_replan_requested" &&
                  typeof event.payload === "object" &&
                  event.payload !== null &&
                  !Array.isArray(event.payload) &&
                  event.payload.reasonCode === "tool_semantic_failure",
              ),
          ).toBe(false);
        } finally {
          bridge?.dispose();
          runtime.close();
        }
      },
    );
  });

  it("labels a pending-tool interruption as provider recovery", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-pending-interrupt-" },
      async (state) => {
        const runtime = start(state.stateDir);
        if (!runtime) {
          throw new Error("acceptance runtime missing");
        }
        try {
          const scope = resolveGovernorAgentLoopRunScope(input());
          if (!scope) {
            throw new Error("acceptance scope missing");
          }
          const tool = scope.governedTools()[0];
          const decision = scope.beforeTool({
            toolCallId: "pending-tool-call",
            toolName: "observe",
            args: { key: "alpha" },
            tool,
            now: 201,
          });
          expect(decision.kind).toBe("allow");
          scope.interrupt({ now: 202 });
          const events = runtime.adapter.controller.store.listEvents(scope.taskId as never);
          expect(runtime.adapter.controller.store.loadTask(scope.taskId as never)?.state).toBe(
            "REPLAN_REQUIRED",
          );
          expect(
            events.some(
              (event) =>
                event.eventType === "runtime_replan_requested" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                !Array.isArray(event.payload) &&
                event.payload.reasonCode === "provider_interrupted",
            ),
          ).toBe(true);
          expect(
            events.some(
              (event) =>
                event.eventType === "runtime_replan_requested" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                !Array.isArray(event.payload) &&
                event.payload.reasonCode === "tool_semantic_failure",
            ),
          ).toBe(false);
          scope.dispose();
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("restores the prior tool inventory and steering on bridge disposal", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-bridge-dispose-" },
      async (state) => {
        const runtime = start(state.stateDir);
        const scope = resolveGovernorAgentLoopRunScope(input());
        if (!scope) {
          throw new Error("acceptance scope missing");
        }
        const original = textTool("legacy", async () => ({ content: [], details: null }));
        const seen: string[] = [];
        const agent = new Agent({
          initialState: { model, tools: [original] },
          streamFn: (_model, context) => {
            for (const message of context.messages) {
              if (typeof message.content === "string") {
                seen.push(message.content);
              } else if (Array.isArray(message.content)) {
                for (const item of message.content) {
                  if (item.type === "text") {
                    seen.push(item.text);
                  }
                }
              }
            }
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
              stream.push({
                type: "done",
                reason: "stop",
                message: assistant([{ type: "text", text: "done" }]),
              });
              stream.end();
            });
            return stream;
          },
        });
        const bridge = installGovernorLoopBridge({ agent, scope, now: () => 300 });
        expect(agent.state.tools.some((tool) => tool.name === "observe")).toBe(true);
        agent.steerKeyed("openclaw-governor-progress", {
          role: "user",
          content: [{ type: "text", text: "temporary governor guidance" }],
          timestamp: 300,
        });
        bridge.dispose();
        expect(agent.state.tools).toEqual([original]);
        await agent.prompt("legacy run");
        expect(agent.state.tools).toEqual([original]);
        expect(seen).not.toContain("temporary governor guidance");
        runtime?.close();
      },
    );
  });
});
