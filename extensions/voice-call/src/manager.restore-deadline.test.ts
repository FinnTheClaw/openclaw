import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  registerTestManagerCleanup,
  writeCallsToStore,
} from "./manager.test-harness.js";
import { findCallInStore, loadActiveCallsFromStore } from "./manager/store.js";
import { setVoiceCallStateRuntime } from "./runtime-state.js";
import type { GetCallStatusResult } from "./types.js";

const active = { status: "in-progress", isTerminal: false } satisfies GetCallStatusResult;
const unknown = {
  status: "error",
  isTerminal: false,
  isUnknown: true,
} satisfies GetCallStatusResult;
const terminal = { status: "completed", isTerminal: true } satisfies GetCallStatusResult;

function installStateRuntime() {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("not used by restore tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("not used by restore tests");
      }) as never,
      openChannelIngressDrain: (() => {
        throw new Error("not used by restore tests");
      }) as never,
    },
  });
}

function makeManager(storePath: string) {
  return registerTestManagerCleanup(
    new CallManager(
      VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        maxDurationSeconds: 300,
      }),
      storePath,
    ),
  );
}

async function restoreAcrossStatus(
  params: {
    result?: GetCallStatusResult;
    reject?: boolean;
    advanceMs?: number;
    startedAgoMs?: number;
    answeredAgoMs?: number;
    hangupReject?: boolean;
  } = {},
) {
  const now = Date.now();
  const storePath = createTestStorePath();
  const call = makePersistedCall({
    startedAt: now - (params.startedAgoMs ?? 299_000),
    answeredAt: now - (params.answeredAgoMs ?? 299_000),
  });
  writeCallsToStore(storePath, [call]);
  const provider = new FakeProvider();
  let settle!: (value: GetCallStatusResult) => void;
  let fail!: (error: Error) => void;
  provider.getCallStatus = () =>
    new Promise<GetCallStatusResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
  if (params.hangupReject) {
    provider.hangupCall = async (input) => {
      provider.hangupCalls.push(input);
      throw new Error("synthetic carrier failure");
    };
  }
  const manager = makeManager(storePath);
  const initializing = manager.initialize(provider, "https://example.com/voice/webhook");
  vi.setSystemTime(now + (params.advanceMs ?? 2_000));
  if (params.reject) {
    fail(new Error("synthetic status failure"));
  } else {
    settle(params.result ?? active);
  }
  await initializing;
  return { call, manager, provider, storePath };
}

function assertExpired(params: Awaited<ReturnType<typeof restoreAcrossStatus>>) {
  const callId = params.call.callId as string;
  const providerCallId = params.call.providerCallId as string;
  expect(params.manager.getActiveCalls()).toHaveLength(0);
  expect(params.manager.getCallByProviderCallId(providerCallId)).toBeUndefined();
  expect(loadActiveCallsFromStore(params.storePath).activeCalls.size).toBe(0);
  expect(findCallInStore(params.storePath, callId)).toMatchObject({
    state: "timeout",
    endReason: "timeout",
  });
  expect(params.provider.hangupCalls).toMatchObject([
    { callId, providerCallId, reason: "timeout" },
  ]);
}

describe("restored voice-call duration crossing", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    onTestFinished(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetPluginStateStoreForTests();
    });
  });

  it("R06-01-C01 expires an active status after verification crosses deadline", async () => {
    assertExpired(await restoreAcrossStatus({ result: active }));
  });

  it("R06-01-C02 expires an unknown status after verification crosses deadline", async () => {
    assertExpired(await restoreAcrossStatus({ result: unknown }));
  });

  it("R06-01-C03 expires a failed status query after crossing deadline", async () => {
    assertExpired(await restoreAcrossStatus({ reject: true }));
  });

  it("R06-01-C04 retains and later times out a call verified before deadline", async () => {
    const restored = await restoreAcrossStatus({ advanceMs: 500 });
    expect(restored.manager.getActiveCalls()).toHaveLength(1);
    expect(restored.provider.hangupCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(501);
    assertExpired(restored);
  });

  it("R06-01-C05 keeps already-expired verification-entry handling", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({
      startedAt: Date.now() - 301_000,
      answeredAt: Date.now() - 301_000,
    });
    writeCallsToStore(storePath, [call]);
    const provider = new FakeProvider();
    const status = vi.spyOn(provider, "getCallStatus");
    const manager = makeManager(storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");
    assertExpired({ call, manager, provider, storePath });
    expect(status).not.toHaveBeenCalled();
  });

  it("R06-01-C06 preserves terminal provider verdict after deadline", async () => {
    const restored = await restoreAcrossStatus({ result: terminal });
    expect(restored.manager.getActiveCalls()).toHaveLength(0);
    expect(restored.provider.hangupCalls).toHaveLength(0);
    expect(findCallInStore(restored.storePath, restored.call.callId as string)).toMatchObject({
      state: "completed",
      endReason: "completed",
    });
  });

  it("R06-01-C07 expires only the crossed call in a mixed restored pair", async () => {
    const now = Date.now();
    const storePath = createTestStorePath();
    const expired = makePersistedCall({ startedAt: now - 299_000, answeredAt: now - 299_000 });
    const survivor = makePersistedCall({ startedAt: now - 30_000, answeredAt: now - 30_000 });
    writeCallsToStore(storePath, [expired, survivor]);
    const provider = new FakeProvider();
    provider.getCallStatus = async () => {
      vi.setSystemTime(now + 2_000);
      return active;
    };
    const manager = makeManager(storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");
    expect(manager.getActiveCalls().map((call) => call.callId)).toEqual([survivor.callId]);
    expect(manager.getCallByProviderCallId(survivor.providerCallId as string)?.callId).toBe(
      survivor.callId,
    );
    expect(provider.hangupCalls).toHaveLength(1);
    expect(findCallInStore(storePath, expired.callId as string)?.state).toBe("timeout");
  });

  it("R06-01-C08 does not hang up an unverifiable missing-provider call", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({ providerCallId: undefined });
    writeCallsToStore(storePath, [call]);
    const provider = new FakeProvider();
    const manager = makeManager(storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");
    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(provider.hangupCalls).toHaveLength(0);
  });

  it("R06-01-C09 persists timeout when carrier hangup rejects", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restored = await restoreAcrossStatus({ hangupReject: true });
    assertExpired(restored);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to hang up expired restored call"),
      "synthetic carrier failure",
    );
  });

  it("R06-01-C10 does not retry a settled timeout on a second initialize", async () => {
    const restored = await restoreAcrossStatus();
    assertExpired(restored);
    const status = vi.spyOn(restored.provider, "getCallStatus");
    await restored.manager.initialize(restored.provider, "https://example.com/voice/webhook");
    expect(restored.provider.hangupCalls).toHaveLength(1);
    expect(status).not.toHaveBeenCalled();
  });
});
