import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveHostGovernorCompletedIngressReplay } from "./governor-agent-loop-host.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability = {
  capability: "fixture.observe",
  version: "1",
  sourceRank: "structured_exact" as const,
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

const env = (stateDir: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "freeze-identity-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "freeze-evidence-key",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "freeze-evidence-v1",
  OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "freeze-receipt-key",
  OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "freeze-ledger-key",
  OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "freeze-deployment-id",
});

const input = (
  sourceMessageId: string,
  sourceSequence = sourceMessageId === "held-source" ? 1 : 2,
) => ({
  runId: `freeze-${sourceMessageId}`,
  sessionKey: "freeze-session",
  sessionId: "freeze-session",
  agentId: "freeze-agent",
  workspaceId: "freeze-workspace",
  channel: "fixture-channel",
  accountId: "freeze-account",
  principalId: "freeze-principal",
  conversationId: "freeze-conversation",
  sourceMessageId,
  sourceSequence,
  prompt: "observe fixture",
  now: 100,
});

function integrations(includeAgentLoop = true) {
  const base = {
    evidenceOwnerId: "freeze-evidence-owner",
    approvalOwnerId: "freeze-approval-owner",
    deliveryOwnerId: "freeze-delivery-owner",
    ownerIngressOwnerId: "freeze-ingress-owner",
    childOwnerId: "freeze-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "freeze-owner-account",
        gatewayInstanceId: "freeze-owner-gateway",
        ownerPrincipal: "freeze-owner-principal",
        actions: ["repair" as const],
        scopeKeys: ["freeze-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
  };
  return includeAgentLoop
    ? {
        ...base,
        agentLoop: {
          mode: "enforce" as const,
          scopes: [{ sessionKey: "freeze-session" }],
          criteria: [{ criterionId: "observed", description: "Observe fixture" }],
          toolBindings: [
            {
              toolName: "observe",
              capability: capability.capability,
              canonicalTarget: "fixture:read",
              criterionId: "observed",
              implementationId: "disposable-observation-v1" as const,
            },
          ],
          maxTurns: 4,
          expectedAssistantTextDigest: governorDigest("fixture"),
        },
      }
    : base;
}

function createRuntime(stateDir: string, includeAgentLoop = true) {
  return createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: env(stateDir),
    stateDir,
    capabilities: [capability],
    integrations: integrations(includeAgentLoop),
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor admission freeze lifecycle", () => {
  it("freezes new work while an issued ticket completes before final close", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-freeze-" },
      async (state) => {
        const runtime = createRuntime(state.stateDir);
        if (!runtime) {
          throw new Error("expected runtime");
        }
        const issued = resolveGovernorAgentLoopRunScope(input("held-source"));
        if (!issued) {
          throw new Error("expected issued scope");
        }
        const tool = issued.governedTools()[0];
        const decision = issued.beforeTool({
          toolCallId: "held-tool-call",
          toolName: "observe",
          args: {},
          tool,
          now: 101,
        });
        if (decision.kind !== "allow" || !decision.ticket) {
          throw new Error("expected held tool ticket");
        }
        const taskEventsBeforeFreeze = runtime.adapter.controller.store.listEvents(
          issued.taskId as never,
        ).length;
        const databasePath = resolveOpenClawStateSqlitePath(env(state.stateDir));
        const databaseBefore = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : null;
        runtime.freeze();
        runtime.freeze();
        expect(() => resolveGovernorAgentLoopRunScope(input("fresh-source"))).toThrow(
          "GOVERNOR_HOST_ADMISSION_FROZEN",
        );
        expect(() => resolveHostGovernorCompletedIngressReplay(input("held-source"))).toThrow(
          "GOVERNOR_HOST_ADMISSION_FROZEN",
        );
        expect(runtime.adapter.controller.store.listEvents(issued.taskId as never)).toHaveLength(
          taskEventsBeforeFreeze,
        );
        issued.afterTool({
          ticket: decision.ticket,
          toolCallId: "held-tool-call",
          toolName: "observe",
          result: { content: [{ type: "text", text: "fixture" }] },
          isError: false,
          now: 102,
        });
        expect(runtime.adapter.controller.store.listEffects(issued.taskId as never)).toHaveLength(
          1,
        );
        runtime.close();
        runtime.close();
        expect(() =>
          runtime.adapter.controller.ingest({
            sourceMessageId: "after-close",
            sourceSequence: 3,
            scope: {} as never,
            contract: {} as never,
            now: 103,
          }),
        ).toThrow("GOVERNOR_HOST_CAPABILITY_CLOSED");
        expect(
          fs.existsSync(databasePath) ? fs.statSync(databasePath).size : null,
        ).toBeGreaterThanOrEqual(databaseBefore ?? 0);
        expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
        expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
        issued.dispose();
      },
    );
  });

  it("binds admission freeze to its owning runtime host", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-freeze-owner-" },
      async (state) => {
        const runtimeA = createRuntime(`${state.stateDir}-a`, true);
        const runtimeB = createRuntime(`${state.stateDir}-b`, false);
        if (!runtimeA || !runtimeB) {
          throw new Error("expected runtimes");
        }
        const beforeBFreeze = resolveGovernorAgentLoopRunScope(input("a-before-b-freeze", 2));
        expect(beforeBFreeze).toBeTruthy();
        beforeBFreeze?.dispose();

        runtimeB.freeze();
        const afterBFreeze = resolveGovernorAgentLoopRunScope(input("a-after-b-freeze", 3));
        expect(afterBFreeze).toBeTruthy();
        afterBFreeze?.dispose();

        runtimeA.freeze();
        expect(() => resolveGovernorAgentLoopRunScope(input("a-after-a-freeze", 4))).toThrow(
          "GOVERNOR_HOST_ADMISSION_FROZEN",
        );
        runtimeB.close();
        runtimeA.close();

        const runtimeC = createRuntime(`${state.stateDir}-c`, true);
        if (!runtimeC) {
          throw new Error("expected replacement runtime");
        }
        expect(() => runtimeA.freeze()).toThrow("GOVERNOR_HOST_CAPABILITY_CLOSED");
        const replacementScope = resolveGovernorAgentLoopRunScope(input("c-after-stale-freeze"));
        expect(replacementScope).toBeTruthy();
        replacementScope?.dispose();
        runtimeC.close();
      },
    );
  });
});
