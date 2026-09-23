// Round-five L4-04: ten targeted per-subscriber notification assertions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { listDevicePairing as listDevicePairingFn } from "openclaw/plugin-sdk/device-bootstrap";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
  notifyRequestStoreKey,
  type NotifySeenRequest,
} from "./notify-state.js";

const listMock = vi.hoisted(() =>
  vi.fn<typeof listDevicePairingFn>(async () => ({ pending: [], paired: [] })),
);
vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  listDevicePairing: listMock,
}));

import { createPairingNotifierService, handleNotifyCommand } from "./notify.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/device-bootstrap");
  vi.resetModules();
});

const request = (id: string) => ({
  requestId: id,
  deviceId: `device-${id}`,
  publicKey: `key-${id}`,
  ts: 2_000,
});

describe("round-five L4-04 per-subscriber retries", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-r5-notify-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    listMock.mockResolvedValue({ pending: [request("one")], paired: [] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function apiFor(sendText: ReturnType<typeof vi.fn>) {
    return createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
          openKeyedStore: <T>(options: { namespace: string; maxEntries: number }) =>
            createPluginStateKeyedStoreForTests<T>("device-pair", { ...options, env }),
        },
        channel: { outbound: { loadAdapter: vi.fn(async () => ({ sendText })) } },
      } as never,
    });
  }

  async function arm(
    api: ReturnType<typeof apiFor>,
    to: string,
    mode = "on",
    extra: { accountId?: string; messageThreadId?: string | number } = {},
  ) {
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: to, ...extra },
      action: mode,
    });
  }

  async function poll(api: ReturnType<typeof apiFor>) {
    const service = createPairingNotifierService(api);
    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await service.stop?.({} as never);
  }

  it.each([
    {
      name: "01 A succeeds while B fails then B retries",
      order: ["A", "B"],
      fail: "B",
      failCount: 1,
      polls: 2,
      expected: ["A", "B", "B"],
    },
    {
      name: "02 B fails before A succeeds then B retries",
      order: ["B", "A"],
      fail: "B",
      failCount: 1,
      polls: 2,
      expected: ["B", "A", "B"],
    },
    {
      name: "03 A fails while B succeeds then A retries",
      order: ["A", "B"],
      fail: "A",
      failCount: 1,
      polls: 2,
      expected: ["A", "B", "A"],
    },
    {
      name: "04 middle B failure does not duplicate A or C",
      order: ["A", "B", "C"],
      fail: "B",
      failCount: 1,
      polls: 2,
      expected: ["A", "B", "C", "B"],
    },
    {
      name: "05 B remains retryable after two failed polls",
      order: ["A", "B"],
      fail: "B",
      failCount: 2,
      polls: 3,
      expected: ["A", "B", "B", "B"],
    },
  ])("$name", async ({ order, fail, failCount, polls, expected }) => {
    const attempts: string[] = [];
    let remaining = failCount;
    const sendText = vi.fn(async ({ to }: { to: string }) => {
      attempts.push(to);
      if (to === fail && remaining-- > 0) {
        throw new Error("temporary failure");
      }
      return { channel: "telegram", to };
    });
    const api = apiFor(sendText);
    for (const to of order) {
      await arm(api, to);
    }
    for (let index = 0; index < polls; index++) {
      await poll(api);
    }
    expect(attempts.slice(0, order.length).sort()).toEqual([...order].sort());
    expect(attempts.slice(order.length)).toEqual(expected.slice(order.length));
  });

  it("06 isolates retry by account for the same chat", async () => {
    const attempts: string[] = [];
    let fail = true;
    const sendText = vi.fn(async ({ accountId }: { accountId?: string }) => {
      attempts.push(accountId ?? "");
      if (accountId === "second" && fail) {
        fail = false;
        throw new Error("temporary failure");
      }
      return { channel: "telegram", to: "chat" };
    });
    const api = apiFor(sendText);
    await arm(api, "chat", "on", { accountId: "first" });
    await arm(api, "chat", "on", { accountId: "second" });
    await poll(api);
    await poll(api);
    expect(attempts.slice(0, 2).sort()).toEqual(["first", "second"]);
    expect(attempts.slice(2)).toEqual(["second"]);
  });

  it("07 isolates retry by thread for the same chat", async () => {
    const attempts: Array<string | number | undefined> = [];
    let fail = true;
    const sendText = vi.fn(async ({ threadId }: { threadId?: string | number }) => {
      attempts.push(threadId);
      if (threadId === 2 && fail) {
        fail = false;
        throw new Error("temporary failure");
      }
      return { channel: "telegram", to: "chat" };
    });
    const api = apiFor(sendText);
    await arm(api, "chat", "on", { messageThreadId: 1 });
    await arm(api, "chat", "on", { messageThreadId: 2 });
    await poll(api);
    await poll(api);
    expect(attempts.slice(0, 2).map(String).sort()).toEqual(["1", "2"]);
    expect(attempts.slice(2)).toEqual([2]);
  });

  it("08 retries only the failed request for B after another request succeeds", async () => {
    listMock.mockResolvedValue({ pending: [request("one"), request("two")], paired: [] });
    const attempts: string[] = [];
    let fail = true;
    const sendText = vi.fn(async ({ to, text }: { to: string; text: string }) => {
      const id = text.includes("ID: one") ? "one" : "two";
      attempts.push(`${to}:${id}`);
      if (to === "B" && id === "one" && fail) {
        fail = false;
        throw new Error("temporary failure");
      }
      return { channel: "telegram", to };
    });
    const api = apiFor(sendText);
    await arm(api, "A");
    await arm(api, "B");
    await poll(api);
    await poll(api);
    expect(attempts.slice(0, 4).sort()).toEqual(["A:one", "B:one", "A:two", "B:two"].sort());
    expect(attempts.slice(4)).toEqual(["B:one"]);
  });

  it("09 retains a failed one-shot arm until its own successful retry", async () => {
    const attempts: string[] = [];
    let fail = true;
    const sendText = vi.fn(async ({ to }: { to: string }) => {
      attempts.push(to);
      if (to === "B" && fail) {
        fail = false;
        throw new Error("temporary failure");
      }
      return { channel: "telegram", to };
    });
    const api = apiFor(sendText);
    await arm(api, "A");
    await arm(api, "B", "once");
    await poll(api);
    await poll(api);
    await poll(api);
    expect(attempts.slice(0, 2).sort()).toEqual(["A", "B"]);
    expect(attempts.slice(2)).toEqual(["B"]);
    const status = await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "B" },
      action: "status",
    });
    expect(status.text).toContain("Mode: off");
  });

  it("10 honors a preexisting request-wide seen record during migration", async () => {
    const sendText = vi.fn(async () => ({ channel: "telegram", to: "chat" }));
    const seen = createPluginStateKeyedStoreForTests<NotifySeenRequest>("device-pair", {
      namespace: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
      maxEntries: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
      defaultTtlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
      env,
    });
    await seen.register(
      notifyRequestStoreKey("one"),
      { requestId: "one", notifiedAtMs: Date.now() },
      { ttlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS },
    );
    const api = apiFor(sendText);
    await arm(api, "A");
    await arm(api, "B");
    await poll(api);
    expect(sendText).not.toHaveBeenCalled();
  });
});
