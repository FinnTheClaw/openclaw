import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import {
  createHostDeliveryImplementation,
  GOVERNOR_CANARY_IMPLEMENTATION_ID,
  GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
  GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
} from "./governor-host-delivery-implementations.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "./governor-host-secrets.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));
vi.mock("../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

function channelConfig(): OpenClawConfig {
  return {
    channels: {
      signal: { enabled: true, httpUrl: "http://127.0.0.1:18080" },
      imessage: { enabled: true, cliPath: "imsg-fixture" },
    },
  } as OpenClawConfig;
}

function runtime(stateDir: string) {
  const secrets = resolveGovernorSecrets(syntheticGovernorSecretsEnvironment(stateDir));
  const cfg = channelConfig();
  return {
    cfg,
    deliveryRuntime: createGovernorHostDeliveryRuntime({
      cfg,
      stateDir,
      deploymentIdentity: secrets.deploymentIdentity,
      identity: secrets.identity,
    }),
  };
}

function completionPayload(text: string) {
  return {
    kind: "completion" as const,
    text,
    certificateDigest: governorDigest({ text }),
  };
}

describe("compiled governor channel delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOutboundTarget.mockImplementation(
      ({ channel, to }: { channel: string; to: string }) => ({
        ok: true,
        to: channel === "signal" ? to.replace(/^uuid:/u, "") : to,
      }),
    );
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct", sendText: mocks.sendText },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
        isEnabled: () => true,
        isConfigured: () => true,
      },
    });
  });

  it("binds Signal and iMessage to compiled send functions and stable receipts", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-send-" },
      async (state) => {
        mocks.sendText
          .mockResolvedValueOnce({
            channel: "signal",
            messageId: "signal-message-fixture",
            timestamp: 1700000000000,
          })
          .mockResolvedValueOnce({
            channel: "imessage",
            messageId: "imessage-message-fixture",
          });
        const { cfg, deliveryRuntime } = runtime(state.stateDir);
        const signal = createHostDeliveryImplementation({
          implementationId: GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
          config: {
            accountId: "default",
            target: "uuid:10000000-0000-4000-8000-000000000001",
            mode: "active",
          },
          mode: "test",
          runtime: deliveryRuntime,
        });
        const imessage = createHostDeliveryImplementation({
          implementationId: GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
          config: { accountId: "default", target: "fixture@example.invalid", mode: "active" },
          mode: "test",
          runtime: deliveryRuntime,
        });
        await expect(
          signal.send({ deliveryKey: "a".repeat(64), payload: completionPayload("signal") }),
        ).resolves.toMatchObject({ status: "sent" });
        await expect(
          imessage.send({ deliveryKey: "b".repeat(64), payload: completionPayload("imessage") }),
        ).resolves.toMatchObject({ status: "sent" });
        expect(mocks.sendText).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            to: "10000000-0000-4000-8000-000000000001",
            text: "signal",
            accountId: "default",
            deliveryQueueId: "a".repeat(64),
          }),
        );
        expect(mocks.sendText).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            to: "fixture@example.invalid",
            text: "imessage",
            accountId: "default",
            deliveryQueueId: "b".repeat(64),
          }),
        );
        cfg.channels!.signal!.enabled = false;
        expect(deliveryRuntime.cfg.channels?.signal?.enabled).toBe(true);
      },
    );
  });

  it("keeps the certified sender bound when the runtime plugin is replaced", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-plugin-swap-" },
      async (state) => {
        const originalSend = vi.fn(async () => ({
          channel: "signal",
          messageId: "bound-original",
        }));
        const replacementSend = vi.fn(async () => ({
          channel: "signal",
          messageId: "mutable-replacement",
        }));
        const plugin = {
          outbound: { deliveryMode: "direct" as const, sendText: originalSend },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            isEnabled: () => true,
            isConfigured: () => true,
          },
        };
        mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
        const { deliveryRuntime } = runtime(state.stateDir);
        const signal = createHostDeliveryImplementation({
          implementationId: GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
          config: {
            accountId: "default",
            target: "uuid:10000000-0000-4000-8000-000000000099",
            mode: "active",
          },
          mode: "test",
          runtime: deliveryRuntime,
        });
        plugin.outbound.sendText = replacementSend;
        mocks.resolveOutboundChannelPlugin.mockReturnValue({
          ...plugin,
          outbound: { ...plugin.outbound, sendText: replacementSend },
        });
        await expect(
          signal.send({ deliveryKey: "9".repeat(64), payload: completionPayload("bound") }),
        ).resolves.toMatchObject({ status: "sent" });
        expect(originalSend).toHaveBeenCalledOnce();
        expect(replacementSend).not.toHaveBeenCalled();
      },
    );
  });

  it("classifies missing provider IDs and thrown sends as unknown without retrying", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-unknown-" },
      async (state) => {
        mocks.sendText
          .mockResolvedValueOnce({
            channel: "signal",
            messageId: "unknown",
          })
          .mockRejectedValueOnce(new Error("synthetic timeout"));
        const { deliveryRuntime } = runtime(state.stateDir);
        const signal = createHostDeliveryImplementation({
          implementationId: GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
          config: {
            accountId: "default",
            target: "uuid:10000000-0000-4000-8000-000000000002",
            mode: "active",
          },
          mode: "test",
          runtime: deliveryRuntime,
        });
        const imessage = createHostDeliveryImplementation({
          implementationId: GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
          config: { accountId: "default", target: "fixture2@example.invalid", mode: "active" },
          mode: "test",
          runtime: deliveryRuntime,
        });
        await expect(
          signal.send({ deliveryKey: "c".repeat(64), payload: completionPayload("one") }),
        ).resolves.toMatchObject({ status: "unknown", reconcileSupported: false });
        await expect(
          imessage.send({ deliveryKey: "d".repeat(64), payload: completionPayload("two") }),
        ).resolves.toMatchObject({ status: "unknown", reconcileSupported: false });
        expect(mocks.sendText).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("fails closed before send for an unknown account or invalid normalized target", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-invalid-" },
      async (state) => {
        const { deliveryRuntime } = runtime(state.stateDir);
        mocks.resolveOutboundChannelPlugin.mockReturnValueOnce({
          outbound: { deliveryMode: "direct", sendText: mocks.sendText },
          config: {
            listAccountIds: () => ["different-account"],
            resolveAccount: () => ({}),
          },
        });
        expect(() =>
          createHostDeliveryImplementation({
            implementationId: GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
            config: {
              accountId: "default",
              target: "uuid:10000000-0000-4000-8000-000000000005",
              mode: "active",
            },
            mode: "test",
            runtime: deliveryRuntime,
          }),
        ).toThrow(/account is unavailable or mismatched/u);

        mocks.resolveOutboundTarget.mockReturnValueOnce({
          ok: false,
          error: new Error("synthetic invalid target"),
        });
        expect(() =>
          createHostDeliveryImplementation({
            implementationId: GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
            config: { accountId: "default", target: "invalid", mode: "active" },
            mode: "test",
            runtime: deliveryRuntime,
          }),
        ).toThrow(/target is invalid/u);
        expect(mocks.sendText).not.toHaveBeenCalled();
      },
    );
  });

  it("records one fixed-location canary receipt across concurrent duplicates and restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-canary-" },
      async (state) => {
        const { deliveryRuntime } = runtime(state.stateDir);
        const create = () =>
          createHostDeliveryImplementation({
            implementationId: GOVERNOR_CANARY_IMPLEMENTATION_ID,
            config: { sinkId: "disposable-v1", mode: "active" },
            mode: "test",
            runtime: deliveryRuntime,
          });
        const deliveryKey = "e".repeat(64);
        const payload = { text: "non-sensitive canary" } as const;
        await Promise.all(
          Array.from({ length: 20 }, () => create().send({ deliveryKey, payload })),
        );
        const dbPath = `${state.stateDir}/governor-canary/disposable-v1/receipts.sqlite3`;
        expect(fs.existsSync(dbPath)).toBe(true);
        await expect(
          create().reconcile({ deliveryKey, payloadDigest: governorDigest(payload) }),
        ).resolves.toMatchObject({ status: "sent" });
        expect(() =>
          createHostDeliveryImplementation({
            implementationId: GOVERNOR_CANARY_IMPLEMENTATION_ID,
            config: { sinkId: "disposable-v1", mode: "active", path: "../escape" },
            mode: "test",
            runtime: deliveryRuntime,
          }),
        ).toThrow(/unknown fields/u);
      },
    );
  });
});
