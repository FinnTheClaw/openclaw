import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
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
import { normalizedC02GatewayRegistry } from "./governor-c02-runtime-test-fixture.js";
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
  moduleIdentity: { id: "c02-simple-efficiency", version: "v1" },
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

const run = (sourceSequence = 1, runId = "c02-gateway-a"): GovernorAgentLoopRunInput => ({
  runId,
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

function environment(systemdInvocationId = "c02-systemd-a"): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-identity-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-evidence-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-receipt-key-long",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-ledger-key-long",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-deployment-long",
    INVOCATION_ID: systemdInvocationId,
  };
}

function runtime(stateDir: string, systemdInvocationId = "c02-systemd-a"): GovernorHostRuntime {
  const created = createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: environment(systemdInvocationId),
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
  if (!created) {
    throw new Error("C02 runtime unavailable");
  }
  return created;
}

function scope(
  host: GovernorHostRuntime,
  input = run(),
  binding: Readonly<{
    modulePlanDigest?: string;
    hostDescriptorDigest?: string;
    installedTools?: readonly AgentTool[];
  }> = {},
): GovernorAgentLoopRunScope {
  const provider = createGovernorAgentLoopScopeProvider({
    controller: host.adapter.controller,
    submitObservedReceipt: host.owners.evidence.submitObservedReceipt,
    capabilities,
    config,
  });
  const base = provider.resolveRunScope(input);
  if (!base) {
    throw new Error("C02 scope unavailable");
  }
  let wrapped: GovernorAgentLoopRunScope;
  try {
    wrapped = host.wrapC02Scope({
      scope: base,
      run: input,
      config,
      modulePlanDigest: binding.modulePlanDigest ?? governorDigest({ schema: "test-c02-plan" }),
      hostDescriptorDigest: binding.hostDescriptorDigest ?? "a".repeat(64),
    });
  } catch (error) {
    base.dispose();
    throw error;
  }
  try {
    wrapped.prepareTools?.(binding.installedTools ?? normalizedC02GatewayRegistry());
  } catch (error) {
    wrapped.dispose();
    throw error;
  }
  return wrapped;
}

async function action(
  target: GovernorAgentLoopRunScope,
  index: number,
  toolName: "read" | "exec",
  args: Record<string, string>,
  options: Readonly<{
    signal?: AbortSignal;
    recordTurn?: boolean;
    finnRequestIds?: readonly string[];
  }> = {},
): Promise<void> {
  const tool = target.governedTools().find((item) => item.name === toolName);
  const now = 200 + index * 10;
  const decision = target.beforeTool({
    toolCallId: `c02-call-${index}`,
    toolName,
    args,
    tool,
    now,
  });
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("C02 action not admitted");
  }
  await target.afterTool({
    ticket: decision.ticket,
    toolCallId: `c02-call-${index}`,
    toolName,
    result: { content: [{ type: "text", text: `result-${index}` }], details: null },
    isError: false,
    ...(options.signal ? { signal: options.signal } : {}),
    now: now + 1,
  });
  if (options.recordTurn === false) {
    return;
  }
  expect(
    target.afterTurn({
      assistantText: "",
      assistantStopReason: "toolUse",
      toolCallCount: 1,
      finnRequestIds:
        options.finnRequestIds ??
        Array.from({ length: index }, (_, request) => `req_c02_${request + 1}`),
      finnRequestIdEvidenceComplete: true,
      now: now + 2,
    }),
  ).toMatchObject({ kind: "continue" });
}

async function complete(target: GovernorAgentLoopRunScope): Promise<void> {
  await action(
    target,
    3,
    "exec",
    { command: "/usr/bin/python3 -c 'print(3)'" },
    { finnRequestIds: ["req_c02_post_1"] },
  );
  expect(
    target.afterTurn({
      assistantText: "done",
      assistantStopReason: "stop",
      toolCallCount: 0,
      finnRequestIds: ["req_c02_post_1", "req_c02_post_2"],
      finnRequestIdEvidenceComplete: true,
      now: 240,
    }),
  ).toEqual({ kind: "complete" });
}

async function checkpointAndRestart(stateDir: string): Promise<{
  host: GovernorHostRuntime;
  target: GovernorAgentLoopRunScope;
}> {
  await createCheckpoint(stateDir);
  const host = runtime(stateDir, "c02-systemd-b");
  const target = scope(host, run(1, "c02-gateway-b"));
  return { host, target };
}

async function createCheckpoint(stateDir: string): Promise<AgentEventPayload> {
  const firstHost = runtime(stateDir);
  const first = scope(firstHost, run(1, "c02-gateway-a"));
  await action(first, 1, "read", { path: "/case/alpha.txt" });
  let resolveReady!: (event: AgentEventPayload) => void;
  const ready = new Promise<AgentEventPayload>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === "c02-gateway-a" && event.stream === "governor_checkpoint") {
      resolveReady(event);
    }
  });
  const shutdown = new AbortController();
  const pending = action(
    first,
    2,
    "read",
    { path: "/case/beta.txt" },
    { signal: shutdown.signal, recordTurn: false },
  );
  const event = await ready;
  expect(event).toMatchObject({
    runId: "c02-gateway-a",
    stream: "governor_checkpoint",
    sessionKey: "c02-session-key",
    sessionId: "c02-session",
    agentId: "c02-agent",
  });
  expect(Object.keys(event.data).toSorted()).toEqual(
    [
      "schema",
      "phase",
      "moduleId",
      "moduleVersion",
      "taskId",
      "opaqueSessionId",
      "toolCallId",
      "effectId",
      "toolName",
      "criterionId",
      "resultDigest",
      "evidenceDigest",
      "sourceHighwater",
      "taskVersion",
      "checkpointId",
      "checkpointDigest",
      "checkpointCreatedAt",
      "gatewayInvocationId",
      "systemdInvocationId",
      "hostDescriptorDigest",
      "modulePlanDigest",
      "runBindingDigest",
      "installedToolDigest",
    ].toSorted(),
  );
  expect(event.data).toMatchObject({
    schema: "openclaw.governor-c02-checkpoint-ready/v1",
    phase: "checkpoint-ready",
    gatewayInvocationId: event.runId,
    systemdInvocationId: "c02-systemd-a",
    criterionId: "c02-observe-b",
    toolName: "read",
  });
  expect(first.disposition).toBe("checkpoint_pending");
  expect(
    first.afterTurn({
      assistantText: "",
      assistantStopReason: "toolUse",
      toolCallCount: 1,
      finnRequestIds: ["req_c02_1", "req_c02_2"],
      finnRequestIdEvidenceComplete: true,
      now: 222,
    }),
  ).toMatchObject({ kind: "continue" });
  shutdown.abort();
  await pending;
  unsubscribe();
  first.dispose();
  firstHost.close();
  return event;
}

afterEach(() => closeOpenClawStateDatabase());

describe("runtime-owned C02 attestation integration", () => {
  it("seals the exact real-store four-turn flow once and accepts repeated terminal checks", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-attestation-success-" },
      async (state) => {
        const { host, target } = await checkpointAndRestart(state.stateDir);
        await complete(target);
        expect(target.terminalEvidence?.().coordinatorRequestIds).toEqual([
          "req_c02_1",
          "req_c02_2",
          "req_c02_post_1",
          "req_c02_post_2",
        ]);
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
        const target = scope(host);
        expect(() =>
          target.beforeTool({
            toolCallId: "forged",
            toolName: "exec",
            args: { command: "/usr/bin/python3 -c 'print(3)'" },
            tool: { ...target.governedTools()[1]! },
            now: 190,
          }),
        ).toThrow("GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH");
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

  it("rejects missing and duplicate installed read or exec identities", async () => {
    for (const tools of [
      normalizedC02GatewayRegistry().slice(0, 1),
      [...normalizedC02GatewayRegistry(), normalizedC02GatewayRegistry()[0]!],
    ]) {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "c02-attestation-registry-" },
        async (state) => {
          const host = runtime(state.stateDir);
          expect(() => scope(host, run(), { installedTools: tools })).toThrow();
          host.close();
        },
      );
    }
  });

  it("releases construction ownership after failed tool preparation and retries cleanly", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-attestation-construction-retry-" },
      async (state) => {
        const host = runtime(state.stateDir);
        expect(() =>
          scope(host, run(), { installedTools: normalizedC02GatewayRegistry().slice(0, 1) }),
        ).toThrow();
        const retried = scope(host);
        expect(retried.governedTools().map((tool) => tool.name)).toEqual(["read", "exec"]);
        retried.dispose();
        host.close();
      },
    );
  });

  it("requires a changed agent and service invocation with unchanged release and plan", async () => {
    const cases = [
      {
        name: "unchanged agent invocation",
        systemd: "c02-systemd-b",
        input: run(1, "c02-gateway-a"),
        binding: {},
      },
      {
        name: "unchanged service invocation",
        systemd: "c02-systemd-a",
        input: run(1, "c02-gateway-b"),
        binding: {},
      },
      {
        name: "changed release binding",
        systemd: "c02-systemd-b",
        input: run(1, "c02-gateway-b"),
        binding: { hostDescriptorDigest: "b".repeat(64) },
      },
      {
        name: "changed plan binding",
        systemd: "c02-systemd-b",
        input: run(1, "c02-gateway-b"),
        binding: { modulePlanDigest: governorDigest({ schema: "forged-plan" }) },
      },
    ] as const;
    for (const hostile of cases) {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `c02-restart-${hostile.name.replaceAll(" ", "-")}-` },
        async (state) => {
          await createCheckpoint(state.stateDir);
          const host = runtime(state.stateDir, hostile.systemd);
          expect(() => scope(host, hostile.input, hostile.binding)).toThrow(
            "GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID",
          );
          host.close();
        },
      );
    }
  });

  it("rejects forged evidence admission signatures and missing turns from the real store", async () => {
    for (const mutation of [
      "UPDATE governor_evidence SET admission_signature = printf('%064d', 0)",
      "DELETE FROM governor_events WHERE event_type = 'runtime_model_turn_recorded' AND json_extract(payload_json, '$.turn') = 2",
    ]) {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "c02-attestation-tamper-" },
        async (state) => {
          const { host, target } = await checkpointAndRestart(state.stateDir);
          await complete(target);
          const database = new DatabaseSync(
            resolveOpenClawStateSqlitePath({
              ...environment(),
              OPENCLAW_STATE_DIR: state.stateDir,
            }),
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
        const { host, target } = await checkpointAndRestart(state.stateDir);
        await complete(target);
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
