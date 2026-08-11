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
  sendMessage: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("../infra/outbound/message.js", () => ({ sendMessage: mocks.sendMessage }));
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
        mocks.sendMessage
          .mockResolvedValueOnce({
            channel: "signal",
            to: "fixture-signal-target",
            via: "direct",
            mediaUrl: null,
            result: {
              channel: "signal",
              messageId: "signal-message-fixture",
              timestamp: 1700000000000,
            },
          })
          .mockResolvedValueOnce({
            channel: "imessage",
            to: "fixture@example.invalid",
            via: "direct",
            mediaUrl: null,
            result: { channel: "imessage", messageId: "imessage-message-fixture" },
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
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            channel: "signal",
            to: "10000000-0000-4000-8000-000000000001",
            content: "signal",
            accountId: "default",
            idempotencyKey: "a".repeat(64),
          }),
        );
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            channel: "imessage",
            to: "fixture@example.invalid",
            content: "imessage",
            accountId: "default",
            idempotencyKey: "b".repeat(64),
          }),
        );
        cfg.channels!.signal!.enabled = false;
        expect(deliveryRuntime.cfg.channels?.signal?.enabled).toBe(true);
      },
    );
  });

  it("classifies missing provider IDs and thrown sends as unknown without retrying", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-unknown-" },
      async (state) => {
        mocks.sendMessage
          .mockResolvedValueOnce({
            channel: "signal",
            to: "fixture-signal-target",
            via: "direct",
            mediaUrl: null,
            result: { channel: "signal", messageId: "unknown" },
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
        expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("fails closed before send for an unknown account or invalid normalized target", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-channel-invalid-" },
      async (state) => {
        const { deliveryRuntime } = runtime(state.stateDir);
        mocks.resolveOutboundChannelPlugin.mockReturnValueOnce({
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
        expect(mocks.sendMessage).not.toHaveBeenCalled();
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
