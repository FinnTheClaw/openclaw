import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeToolParameters } from "../agents/agent-tools.schema.js";
import { createExecTool } from "../agents/bash-tools.exec.js";
import { createReadTool } from "../agents/sessions/tools/read.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { createGovernorAgentLoopScopeProvider } from "./governor-agent-loop-scope-provider.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import {
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostRuntime,
} from "./governor-host-bootstrap.js";

const capabilities = [
  {
    capability: "read",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/observations"],
    requiresApproval: false,
  },
  {
    capability: "exec",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/aggregate"],
    requiresApproval: false,
  },
];

const config: GovernorAgentLoopConfiguration = {
  mode: "enforce",
  scopes: [{ sessionKey: "c02-session-key", agentId: "c02-agent" }],
  criteria: [
    { criterionId: "c02-observe-a", description: "observe a" },
    { criterionId: "c02-observe-b", description: "observe b" },
    {
      criterionId: "c02-aggregate",
      description: "aggregate",
      dependsOnCriteria: ["c02-observe-a", "c02-observe-b"],
    },
  ],
  toolBindings: [
    {
      toolName: "read",
      capability: "read",
      canonicalTarget: "campaign://c02/observations",
      criterionArgument: "path",
      criteriaByValue: {
        "/case/alpha.txt": "c02-observe-a",
        "/case/beta.txt": "c02-observe-b",
      },
      implementationId: "installed-tool:read",
    },
    {
      toolName: "exec",
      capability: "exec",
      canonicalTarget: "campaign://c02/aggregate",
      criterionArgument: "command",
      criteriaByValue: { "/usr/bin/python3 -c 'print(3)'": "c02-aggregate" },
      implementationId: "installed-tool:exec",
    },
  ],
  maxTurns: 8,
};

const run = (sourceSequence = 1): GovernorAgentLoopRunInput => ({
  runId: "c02-run",
  sessionKey: "c02-session-key",
  sessionId: "c02-session",
  agentId: "c02-agent",
  workspaceId: "c02-workspace",
  channel: "c02-channel",
  accountId: "c02-account",
  principalId: "c02-principal",
  conversationId: "c02-conversation",
  sourceMessageId: `c02-message-${sourceSequence}`,
  sourceSequence,
  prompt: "run exact c02 campaign",
  now: 100,
});

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-identity-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-evidence-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-receipt-key-long",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-ledger-key-long",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-deployment-long",
  };
}

function runtime(stateDir: string): GovernorHostRuntime {
  const created = createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: environment(),
    stateDir,
    capabilities,
    integrations: {
      evidenceOwnerId: "c02-evidence-owner",
      approvalOwnerId: "c02-approval-owner",
      deliveryOwnerId: "c02-delivery-owner",
      ownerIngressOwnerId: "c02-ingress-owner",
      childOwnerId: "c02-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-owner-account",
          gatewayInstanceId: "c02-owner-gateway",
          ownerPrincipal: "c02-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
    },
  });
  if (!created) throw new Error("C02 runtime unavailable");
  return created;
}

function scope(
  host: GovernorHostRuntime,
  stateDir: string,
  input = run(),
): GovernorAgentLoopRunScope {
  const provider = createGovernorAgentLoopScopeProvider({
    controller: host.adapter.controller,
    submitObservedReceipt: host.owners.evidence.submitObservedReceipt,
    capabilities,
    config,
  });
  const base = provider.resolveRunScope(input);
  if (!base) throw new Error("C02 scope unavailable");
  const wrapped = host.wrapC02Scope({
    scope: base,
    run: input,
    config,
    modulePlanDigest: governorDigest({ schema: "test-c02-plan" }),
    hostDescriptorDigest: "a".repeat(64),
  });
  wrapped.prepareTools?.(
    [createReadTool(stateDir), createExecTool({ cwd: stateDir })].map((tool) =>
      normalizeToolParameters(tool),
    ),
  );
  return wrapped;
}

function action(
  target: GovernorAgentLoopRunScope,
  index: number,
  toolName: "read" | "exec",
  args: Record<string, string>,
): void {
  const tool = target.governedTools().find((item) => item.name === toolName);
  const now = 200 + index * 10;
  const decision = target.beforeTool({
    toolCallId: `c02-call-${index}`,
    toolName,
    args,
    tool,
    now,
  });
  if (decision.kind !== "allow" || !decision.ticket) throw new Error("C02 action not admitted");
  target.afterTool({
    ticket: decision.ticket,
    toolCallId: `c02-call-${index}`,
    toolName,
    result: { content: [{ type: "text", text: `result-${index}` }], details: null },
    isError: false,
    now: now + 1,
  });
  expect(
    target.afterTurn({
      assistantText: "",
      assistantStopReason: "toolUse",
      toolCallCount: 1,
      now: now + 2,
    }),
  ).toMatchObject({ kind: "continue" });
}

function complete(target: GovernorAgentLoopRunScope): void {
  action(target, 1, "read", { path: "/case/alpha.txt" });
  action(target, 2, "read", { path: "/case/beta.txt" });
  action(target, 3, "exec", { command: "/usr/bin/python3 -c 'print(3)'" });
  expect(
    target.afterTurn({
      assistantText: "done",
      assistantStopReason: "stop",
      toolCallCount: 0,
      now: 240,
    }),
  ).toEqual({ kind: "complete" });
}

afterEach(() => closeOpenClawStateDatabase());

describe("runtime-owned C02 attestation integration", () => {
  it("seals the exact real-store four-turn flow once and accepts repeated terminal checks", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-attestation-success-" },
      async (state) => {
        const host = runtime(state.stateDir);
        const target = scope(host, state.stateDir);
        complete(target);
        expect(() => target.assertTerminal()).not.toThrow();
        expect(() => target.assertTerminal()).not.toThrow();
        target.dispose();
        host.close();
      },
    );
  });

  it("rejects tool substitution and aggregate-before-observations", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-attestation-tools-" },
      async (state) => {
        const host = runtime(state.stateDir);
        const target = scope(host, state.stateDir);
        expect(
          target.beforeTool({
            toolCallId: "forged",
            toolName: "exec",
            args: { command: "/usr/bin/python3 -c 'print(3)'" },
            tool: { ...target.governedTools()[1]! },
            now: 190,
          }),
        ).toMatchObject({ kind: "block" });
        expect(
          target.beforeTool({
            toolCallId: "early",
            toolName: "exec",
            args: { command: "/usr/bin/python3 -c 'print(3)'" },
            tool: target.governedTools()[1],
            now: 191,
          }),
        ).toMatchObject({ kind: "block", reasonCode: "C02_ACTION_NOT_ELIGIBLE" });
        target.dispose();
        host.close();
      },
    );
  });

  it("rejects forged evidence admission signatures and missing turns from the real store", async () => {
    for (const mutation of [
      "UPDATE governor_evidence SET admission_signature = printf('%064d', 0)",
      "DELETE FROM governor_events WHERE event_type = 'runtime_model_turn_recorded' AND json_extract(payload_json, '$.turn') = 2",
    ]) {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "c02-attestation-tamper-" },
        async (state) => {
          const host = runtime(state.stateDir);
          const target = scope(host, state.stateDir);
          complete(target);
          const database = new DatabaseSync(
            resolveOpenClawStateSqlitePath({ ...environment(), OPENCLAW_STATE_DIR: state.stateDir }),
          );
          database.exec(mutation);
          database.close();
          expect(() => target.assertTerminal()).toThrow();
          target.dispose();
          host.close();
        },
      );
    }
  });

  it("rejects a completed task after a newer source advances the real highwater", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-attestation-highwater-" },
      async (state) => {
        const host = runtime(state.stateDir);
        const target = scope(host, state.stateDir);
        complete(target);
        const newer = createGovernorAgentLoopScopeProvider({
          controller: host.adapter.controller,
          submitObservedReceipt: host.owners.evidence.submitObservedReceipt,
          capabilities,
          config,
        }).resolveRunScope(run(2));
        expect(newer).toBeDefined();
        expect(() => target.assertTerminal()).toThrow("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
        newer?.dispose();
        target.dispose();
        host.close();
      },
    );
  });
});
