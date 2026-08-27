import { afterEach, describe, expect, it, vi } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import {
  resolveGovernorAgentLoopRunScope,
  type GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-readonly.js";
import * as hostBootstrap from "../security/governor-host-bootstrap.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBehaviorGovernorRuntime } from "./behavior-governor-runtime.js";

const capability: GovernorCapabilityDefinition = {
  capability: "fixture.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function runInput(prompt: string) {
  return {
    runId: "selected-c03-run",
    sessionKey: "selected-c03-session",
    sessionId: "selected-c03-session-id",
    agentId: "fixture-agent",
    workspaceId: "fixture-workspace",
    channel: "fixture-channel",
    accountId: "fixture-account",
    principalId: "fixture-principal",
    conversationId: "fixture-conversation",
    sourceMessageId: "fixture-message",
    sourceSequence: 1,
    prompt,
    now: 100,
  };
}

function install(agent: Agent, scope: GovernorAgentLoopRunScope) {
  let timestamp = 1_000;
  return installGovernorLoopBridge({ agent, scope, now: () => ++timestamp });
}

function integrations() {
  return {
    evidenceOwnerId: "fixture-evidence-owner",
    approvalOwnerId: "fixture-approval-owner",
    deliveryOwnerId: "fixture-delivery-owner",
    ownerIngressOwnerId: "fixture-ingress-owner",
    childOwnerId: "fixture-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "fixture-owner-account",
        gatewayInstanceId: "fixture-owner-gateway",
        ownerPrincipal: "fixture-owner-principal",
        actions: ["repair" as const],
        scopeKeys: ["fixture-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
  };
}

function activateConfig(stateDir: string, mode: "shadow" | "enforce", observationIds: string[]) {
  const agentLoop = {
    scopes: [{ sessionKey: "selected-c03-session" }],
    criteria: [
      ...observationIds.map((criterionId) => ({
        criterionId,
        description: `Observe ${criterionId}`,
      })),
      { criterionId: "aggregate", description: "Verify aggregate" },
    ],
    toolBindings: [
      {
        toolName: "observe",
        capability: capability.capability,
        canonicalTarget: "fixture:observe",
        criterionArgument: "key",
        criteriaByValue: Object.fromEntries(observationIds.map((id) => [id, id])),
        implementationId: "disposable-observation-fail-once-v1",
      },
      {
        toolName: "aggregate",
        capability: capability.capability,
        canonicalTarget: "fixture:aggregate",
        criterionId: "aggregate",
        implementationId: "disposable-aggregate-v1",
      },
    ],
    maxTurns: 30,
    expectedAssistantTextDigest: governorDigest("42"),
  };
  const secretRefs = {
    identityHmacKey: { source: "env", provider: "default", id: "GOV_IDENTITY" },
    evidenceAdmissionKey: { source: "env", provider: "default", id: "GOV_EVIDENCE" },
    receiptSigningKey: { source: "env", provider: "default", id: "GOV_RECEIPT" },
    ledgerSigningKey: { source: "env", provider: "default", id: "GOV_LEDGER" },
    deploymentIdentity: { source: "env", provider: "default", id: "GOV_DEPLOYMENT" },
  } as const;
  const sourceGovernor = {
    enabled: true as const,
    mode,
    secretRefs,
    agentLoop,
    modules: [{ id: "C03.DEEP_PRODUCTIVE_LOOP", version: "1.0.0", mode }],
  };
  const sourceConfig = { experimental: { behaviorGovernor: sourceGovernor } } as OpenClawConfig;
  const snapshot: PreparedSecretsRuntimeSnapshot = {
    sourceConfig,
    config: {
      experimental: {
        behaviorGovernor: {
          ...sourceGovernor,
          secretRefs: {
            identityHmacKey: "fixture-identity-key",
            evidenceAdmissionKey: "fixture-evidence-key",
            receiptSigningKey: "fixture-receipt-key",
            ledgerSigningKey: "fixture-ledger-key",
            deploymentIdentity: "fixture-deployment",
            evidenceAdmissionKeyId: "fixture-v1",
          },
        },
      },
    } as OpenClawConfig,
    authStores: [],
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: {
      env: { NODE_ENV: "test", OPENCLAW_STATE_DIR: stateDir },
      explicitAgentDirs: null,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
  return sourceConfig;
}

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  vi.restoreAllMocks();
});

describe("selected C03 behavior module integration", () => {
  it("routes the full real loop through selected enforce C03", async () => {
    const mode = "enforce" as const;
    await withOpenClawTestState(
      { layout: "state-only", prefix: `selected-c03-${mode}-` },
      async (state) => {
        const observationIds = Array.from({ length: 20 }, (_, index) => `obs-${index + 1}`);
        const config = activateConfig(state.stateDir, mode, observationIds);
        let captured: hostBootstrap.GovernorHostRuntime | null = null;
        const original = hostBootstrap.createGovernorHostRuntimeIfEnabled;
        vi.spyOn(hostBootstrap, "createGovernorHostRuntimeIfEnabled").mockImplementation(
          (params) => {
            captured = original(params);
            return captured;
          },
        );
        const hostClose = vi.fn();
        const runtime = createGatewayBehaviorGovernorRuntime({
          hostFactory: () => ({
            capabilities: [capability],
            integrations: integrations(),
            close: hostClose,
          }),
        });
        await runtime.apply(config);
        const scope = resolveGovernorAgentLoopRunScope(runInput(`selected-${mode}`));
        expect(scope?.mode).toBe(mode);
        const callerObserve = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "caller" }],
          details: null,
        }));
        const callerAggregate = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "caller-aggregate" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: {
            model,
            tools: [textTool("observe", callerObserve), textTool("aggregate", callerAggregate)],
          },
          streamFn: scriptedStream(() => {
            turn += 1;
            if (turn === 1) {
              return assistant([
                {
                  type: "toolCall",
                  id: "failed-observation",
                  name: "observe",
                  arguments: { key: observationIds[0] },
                },
              ]);
            }
            if (turn <= 21) {
              const key = observationIds[turn - 2]!;
              return assistant([
                { type: "toolCall", id: `observation-${key}`, name: "observe", arguments: { key } },
              ]);
            }
            if (turn === 22) {
              return assistant([{ type: "text", text: "premature" }]);
            }
            if (turn === 23) {
              return assistant([
                { type: "toolCall", id: "aggregate-call", name: "aggregate", arguments: {} },
              ]);
            }
            return assistant([{ type: "text", text: "42" }]);
          }),
        });
        const bridge = install(agent, scope!);
        await agent.prompt(`selected-${mode}`);
        bridge.assertTerminal();
        expect(turn).toBe(24);
        expect(callerObserve).not.toHaveBeenCalled();
        expect(callerAggregate).not.toHaveBeenCalled();
        const task = captured!.adapter.controller.store.loadTask(scope!.taskId as never)!;
        const evidence = captured!.adapter.controller.store.listEvidence(scope!.taskId as never);
        const events = captured!.adapter.controller.store.listEvents(scope!.taskId as never);
        const failedEffects = events.filter(
          (event) =>
            event.eventType === "tool_outcome_recorded" &&
            (event.payload as { semantic?: string }).semantic === "transient_failure",
        );
        const nonGuidanceReplanRequests = events
          .filter((event) => event.eventType === "runtime_replan_requested")
          .filter((event) => (event.payload as { guidanceOnly?: boolean }).guidanceOnly !== true);
        const planChanges = events.filter((event) => event.eventType === "plan_replaced");
        const aggregateEvidence = evidence.find((item) => item.criterionId === "aggregate")!;
        const observationEvidence = evidence.filter((item) => item.criterionId !== "aggregate");
        bridge.dispose();
        await runtime.close();
        expect(task).toMatchObject({ state: "COMPLETED", planVersion: 1 });
        expect(failedEffects).toHaveLength(1);
        expect(nonGuidanceReplanRequests).toHaveLength(0);
        expect(planChanges).toHaveLength(1);
        expect(evidence).toHaveLength(21);
        expect(new Set(observationEvidence.map((item) => item.criterionId))).toEqual(
          new Set(observationIds),
        );
        expect(
          evidence.every(
            (item) =>
              item.sourceKind === "tool" &&
              item.sourceIdentity.startsWith("oesr_") &&
              item.taskId === task.taskId &&
              item.objectiveRevision === task.objectiveRevision &&
              item.planVersion === task.planVersion &&
              item.admissibility === "admitted" &&
              item.invalidatedAt === undefined &&
              item.admissionSignature.length > 0,
          ),
        ).toBe(true);
        expect(aggregateEvidence.observedAt).toBeGreaterThan(
          Math.max(...observationEvidence.map((item) => item.observedAt)),
        );
        expect(hostClose).toHaveBeenCalledOnce();
      },
    );
  });

  it("selects shadow C03 without replacing ordinary tool execution", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "selected-c03-shadow-" },
      async (state) => {
        const config = activateConfig(state.stateDir, "shadow", ["obs-1"]);
        const hostClose = vi.fn();
        const runtime = createGatewayBehaviorGovernorRuntime({
          hostFactory: () => ({
            capabilities: [capability],
            integrations: integrations(),
            close: hostClose,
          }),
        });
        await runtime.apply(config);
        const scope = resolveGovernorAgentLoopRunScope(runInput("selected-shadow"))!;
        const execute = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: null,
        }));
        let turn = 0;
        const agent = new Agent({
          initialState: { model, tools: [textTool("observe", execute)] },
          streamFn: scriptedStream(() =>
            ++turn === 1
              ? assistant([
                  {
                    type: "toolCall",
                    id: "shadow-observe",
                    name: "observe",
                    arguments: { key: "obs-1" },
                  },
                ])
              : assistant([{ type: "text", text: "ordinary-result" }]),
          ),
        });
        const bridge = install(agent, scope);
        await agent.prompt("selected-shadow");
        bridge.assertTerminal();
        expect(execute).toHaveBeenCalledOnce();
        bridge.dispose();
        await runtime.close();
        expect(hostClose).toHaveBeenCalledOnce();
      },
    );
  });
});
