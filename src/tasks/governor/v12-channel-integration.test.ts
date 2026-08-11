import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostIntegrationConfiguration,
} from "../../security/governor-host-bootstrap.js";
import {
  GOVERNOR_CANARY_IMPLEMENTATION_ID,
  GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
  GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
} from "../../security/governor-host-delivery-implementations.js";
import { syntheticGovernorSecretsEnvironment } from "../../security/governor-host-secrets.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GovernorController } from "./controller.js";
import type { GovernorOutboxDeliveryBinding } from "./outbox-store.js";
import type { GovernorSqliteStore } from "./store.js";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));
vi.mock("../../infra/outbound/message.js", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));
vi.mock("../../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

function env(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...syntheticGovernorSecretsEnvironment(stateDir),
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
  };
}

function cfg(): OpenClawConfig {
  return {
    channels: {
      signal: { enabled: true, httpUrl: "http://127.0.0.1:18080" },
      imessage: { enabled: true, cliPath: "imsg-fixture" },
    },
  } as OpenClawConfig;
}

function integrations(
  implementationId: string,
  config: GovernorHostIntegrationConfiguration["deliveries"][number]["config"],
): GovernorHostIntegrationConfiguration {
  return {
    evidenceOwnerId: "evidence-owner",
    approvalOwnerId: "approval-owner",
    deliveryOwnerId: "delivery-owner",
    ownerIngressOwnerId: "owner-ingress-owner",
    ownerIngressBindings: [
      {
        channel: "signal",
        accountId: "fixture-owner-account",
        gatewayInstanceId: "fixture-owner-gateway",
        ownerPrincipal: "fixture-owner-principal",
        actions: ["approve"],
        scopeKeys: ["fixture-owner-scope"],
      },
    ],
    channelConfig: cfg(),
    deliveries: [{ implementationId, config, generation: 1 }],
  };
}

function complete(controller: GovernorController, suffix = "") {
  const taskId = controller.ingest({
    sourceMessageId: `v12-completion-message${suffix}`,
    sourceSequence: 1,
    scope: {
      principalId: "v12-principal",
      channel: "synthetic",
      accountId: "v12-account",
      conversationId: `v12-conversation${suffix}`,
      sessionId: `v12-session${suffix}`,
      agentId: "v12-agent",
      workspaceId: "v12-workspace",
    },
    mode: "FOCUSED",
    contract: {
      objective: "deliver a synthetic completion",
      constraints: [],
      knownFacts: [],
      unknowns: [],
      completionCriteria: [],
      authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
    },
    now: 1,
  }).task.taskId;
  controller.preparePlan({ taskId, plan: { kind: "ordered", steps: [] }, now: 2 });
  controller.startExecution(taskId, 3);
  controller.beginVerification(taskId, 4);
  const result = controller.proposeFinish({
    taskId,
    response: { framing: "summary", materialClaimIds: [] },
    now: 5,
  });
  if (!result.completed) {
    throw new Error("expected governor completion");
  }
  const outbox = controller.store.outbox.list(taskId)[0];
  if (!outbox) {
    throw new Error("expected governor outbox");
  }
  return { taskId, effectId: outbox.effectId, expectedLeaseEpoch: result.task.leaseEpoch };
}

function binding(
  entry: ReturnType<GovernorSqliteStore["resolveCertifiedDelivery"]>,
): GovernorOutboxDeliveryBinding {
  return {
    adapterHandle: entry.handle,
    identityKey: entry.identityKey,
    implementationDigest: entry.implementationDigest,
    configDigest: entry.configDigest,
    generation: entry.generation,
    channel: entry.binding.channel,
    accountIdentity: entry.binding.accountIdentity,
    targetIdentity: entry.binding.targetIdentity,
    deploymentIdentity: entry.binding.deploymentIdentity,
  };
}

beforeEach(() => {
  mocks.resolveOutboundTarget.mockImplementation(
    ({ channel, to }: { channel: string; to: string }) => ({
      ok: true,
      to: channel === "signal" ? to.replace(/^uuid:/u, "") : to,
    }),
  );
  mocks.resolveOutboundChannelPlugin.mockReturnValue({
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isEnabled: () => true,
      isConfigured: () => true,
    },
  });
});

afterEach(() => {
  mocks.sendMessage.mockReset();
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundChannelPlugin.mockReset();
  closeOpenClawStateDatabase();
});

describe("V12 compiled governor integrations", () => {
  it("keeps feature-off construction inert even with hostile integration getters", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "deliveries", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("feature-off accessed integrations");
      },
    }) as GovernorHostIntegrationConfiguration;
    expect(
      createGovernorHostRuntimeIfEnabled({
        env: { OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "0" },
        capabilities: [],
        integrations: hostile,
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  it("performs a shadow canary decision without creating the sink", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-v12-shadow-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: env(state.stateDir),
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integrations(GOVERNOR_CANARY_IMPLEMENTATION_ID, {
            sinkId: "disposable-v1",
            mode: "shadow",
          }),
        });
        if (!runtime) {
          throw new Error("expected runtime");
        }
        const completion = complete(runtime.adapter.controller);
        const result = await runtime.adapter.controller.dispatchOutbox({
          ...completion,
          workerId: "shadow-worker",
          adapterHandle: runtime.deliveryHandles[0],
          now: 10,
        });
        expect(result.kind).toBe("would_send");
        expect(runtime.adapter.controller.store.outbox.list(completion.taskId)[0]?.state).toBe(
          "would_send",
        );
        expect(fs.existsSync(path.join(state.stateDir, "governor-canary"))).toBe(false);
      },
    );
  });

  it("reconciles a canary crash after acceptance without a second visible append", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-v12-canary-" },
      async (state) => {
        const integration = integrations(GOVERNOR_CANARY_IMPLEMENTATION_ID, {
          sinkId: "disposable-v1",
          mode: "active",
        });
        const first = createGovernorHostRuntimeIfEnabled({
          env: env(state.stateDir),
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integration,
        });
        if (!first) {
          throw new Error("expected runtime");
        }
        const completion = complete(first.adapter.controller);
        const adapter = first.adapter.controller.store.resolveCertifiedDelivery(
          first.deliveryHandles[0],
        );
        const claim = first.adapter.controller.store.outbox.claim({
          ...completion,
          workerId: "crashed-worker",
          now: 10,
          leaseDurationMs: 1,
          deliveryBinding: binding(adapter),
        });
        if (claim.kind !== "claimed") {
          throw new Error("expected canary claim");
        }
        await adapter.send({ deliveryKey: claim.entry.deliveryKey, payload: claim.entry.payload });
        closeOpenClawStateDatabase();
        const restarted = createGovernorHostRuntimeIfEnabled({
          env: env(state.stateDir),
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integration,
        });
        if (!restarted) {
          throw new Error("expected restarted runtime");
        }
        const result = await restarted.adapter.controller.dispatchOutbox({
          ...completion,
          workerId: "recovery-worker",
          adapterHandle: restarted.deliveryHandles[0],
          now: 20,
        });
        expect(result.kind).toBe("claimed");
        expect(restarted.adapter.controller.store.outbox.list(completion.taskId)[0]?.state).toBe(
          "sent",
        );
        const canaryDb = new DatabaseSync(
          path.join(state.stateDir, "governor-canary", "disposable-v1", "receipts.sqlite3"),
          { readOnly: true },
        );
        try {
          expect(canaryDb.prepare("SELECT COUNT(*) AS count FROM receipts").get()).toEqual({
            count: 1,
          });
        } finally {
          canaryDb.close();
        }
      },
    );
  });

  it.each([
    [
      "Signal",
      GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
      { accountId: "default", target: "uuid:10000000-0000-4000-8000-000000000003", mode: "active" },
    ],
    [
      "iMessage",
      GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
      { accountId: "default", target: "fixture3@example.invalid", mode: "active" },
    ],
  ] as const)(
    "leaves one manual-review state for an unknown %s outcome",
    async (_label, implementationId, config) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-governor-v12-unknown-" },
        async (state) => {
          mocks.sendMessage.mockRejectedValue(new Error("synthetic timeout"));
          const runtime = createGovernorHostRuntimeIfEnabled({
            env: env(state.stateDir),
            stateDir: state.stateDir,
            capabilities: [],
            integrations: integrations(implementationId, config),
          });
          if (!runtime) {
            throw new Error("expected runtime");
          }
          const completion = complete(runtime.adapter.controller);
          const request = {
            ...completion,
            workerId: "unknown-worker",
            adapterHandle: runtime.deliveryHandles[0],
            now: 10,
          };
          expect((await runtime.adapter.controller.dispatchOutbox(request)).kind).toBe(
            "manual_review",
          );
          expect(
            (await runtime.adapter.controller.dispatchOutbox({ ...request, now: 20 })).kind,
          ).toBe("manual_review");
          expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        },
      );
    },
  );

  it("rejects a valid host receipt bound to a different outbox effect", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-v12-receipt-binding-" },
      async (state) => {
        mocks.sendMessage.mockResolvedValue({
          channel: "signal",
          to: "fixture-target",
          via: "direct",
          mediaUrl: null,
          result: { channel: "signal", messageId: "stable-binding-fixture" },
        });
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: env(state.stateDir),
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integrations(GOVERNOR_SIGNAL_IMPLEMENTATION_ID, {
            accountId: "default",
            target: "uuid:10000000-0000-4000-8000-000000000005",
            mode: "active",
          }),
        });
        if (!runtime) {
          throw new Error("expected runtime");
        }
        const first = complete(runtime.adapter.controller, "-first");
        const second = complete(runtime.adapter.controller, "-second");
        const adapter = runtime.adapter.controller.store.resolveCertifiedDelivery(
          runtime.deliveryHandles[0],
        );
        const firstClaim = runtime.adapter.controller.store.outbox.claim({
          ...first,
          workerId: "first-worker",
          now: 10,
          deliveryBinding: binding(adapter),
        });
        const secondClaim = runtime.adapter.controller.store.outbox.claim({
          ...second,
          workerId: "second-worker",
          now: 10,
          deliveryBinding: binding(adapter),
        });
        if (firstClaim.kind !== "claimed" || secondClaim.kind !== "claimed") {
          throw new Error("expected two claimed outbox effects");
        }
        const delivery = await adapter.send({
          deliveryKey: firstClaim.entry.deliveryKey,
          payload: firstClaim.entry.payload,
        });
        if (delivery.status !== "sent") {
          throw new Error("expected a signed host delivery receipt");
        }
        const verified = runtime.adapter.controller.store.verifyCertifiedDeliveryReceipt(
          delivery.receipt,
        );
        if (!verified) {
          throw new Error("expected a verified host delivery receipt");
        }
        expect(() =>
          runtime.adapter.controller.store.outbox.markSent({
            taskId: second.taskId,
            effectId: second.effectId,
            expectedLeaseEpoch: second.expectedLeaseEpoch,
            expectedDeliveryClaimEpoch: secondClaim.entry.deliveryClaimEpoch,
            workerId: "second-worker",
            verifiedReceipt: verified,
            now: 11,
          }),
        ).toThrow(/receipt binding is mismatched/u);
        expect(runtime.adapter.controller.store.outbox.list(second.taskId)[0]?.state).toBe(
          "claimed",
        );
      },
    );
  });

  it.each([
    [
      "Signal",
      GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
      { accountId: "default", target: "uuid:10000000-0000-4000-8000-000000000004", mode: "active" },
    ],
    [
      "iMessage",
      GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
      { accountId: "default", target: "fixture4@example.invalid", mode: "active" },
    ],
  ] as const)(
    "sends one visible %s delivery across concurrent duplicates",
    async (label, implementationId, config) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-governor-v12-concurrent-" },
        async (state) => {
          mocks.sendMessage.mockResolvedValue({
            channel: label === "Signal" ? "signal" : "imessage",
            to: "fixture-target",
            via: "direct",
            mediaUrl: null,
            result: {
              channel: label === "Signal" ? "signal" : "imessage",
              messageId: "stable-message-fixture",
              timestamp: 1_700_000_000_000,
            },
          });
          const runtime = createGovernorHostRuntimeIfEnabled({
            env: env(state.stateDir),
            stateDir: state.stateDir,
            capabilities: [],
            integrations: integrations(implementationId, config),
          });
          if (!runtime) {
            throw new Error("expected runtime");
          }
          const completion = complete(runtime.adapter.controller);
          const request = {
            ...completion,
            workerId: "concurrent-worker",
            adapterHandle: runtime.deliveryHandles[0],
            now: 10,
          };
          await Promise.all(
            Array.from({ length: 20 }, () => runtime.adapter.controller.dispatchOutbox(request)),
          );
          expect(
            (await runtime.adapter.controller.dispatchOutbox({ ...request, now: 20 })).kind,
          ).toBe("already_sent");
          expect(runtime.adapter.controller.store.outbox.list(completion.taskId)[0]?.state).toBe(
            "sent",
          );
          expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
        },
      );
    },
  );
});
