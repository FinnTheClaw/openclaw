import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  REPLACEMENT_TEST_RELAY_KEY,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

const cases = [
  ["P01 normal pairing", "normal"],
  ["P02 normal revoke", "revoke"],
  ["P03 inventory rejection closes socket", "inventory-close"],
  ["P04 inventory rejection detaches debugger", "inventory-detach"],
  ["P05 same-revision retry", "retry"],
  ["P06 repeated reconciliation idempotent", "idempotent"],
  ["P07 pending-inventory revoke", "pending"],
  ["P08 debugger attached with no active socket", "no-socket"],
  ["P09 one inventory failure then healthy retry", "fail-then-retry"],
  ["P10 later valid pairing after cleanup", "re-pair"],
] as const;

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CH03 browser pairing invalidation cleanup", () => {
  it.each(cases)("%s", async (_name, mode) => {
    const h = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 7, url: "https://example.com/7", groupId: -1 }],
    });
    const socket = h.relaySockets[0]!;
    await h.authenticate(socket);
    expect(socket.readyState).toBe(1);
    if (mode === "normal") {
      expect(await sendRuntimeMessage(h, { type: "getStatus" })).toMatchObject({ paired: true });
      expect(socket.close).not.toHaveBeenCalled();
      return;
    }
    const shouldAttach = mode === "inventory-detach" || mode === "no-socket";
    if (shouldAttach) {
      socket.receive({ type: "attach", seq: 91, tabId: 7 });
      await vi.waitFor(() => expect(h.debuggerAttach).toHaveBeenCalledWith({ tabId: 7 }, "1.3"));
    }
    if (mode === "no-socket") {
      socket.close();
    }
    // A persisted credential that fails parsing invalidates the active pairing revision.
    h.storageValues.token = "invalid-pairing-token";
    if (
      mode === "inventory-close" ||
      mode === "inventory-detach" ||
      mode === "retry" ||
      mode === "fail-then-retry" ||
      mode === "re-pair"
    ) {
      h.tabsQuery.mockRejectedValueOnce(new Error("inventory unavailable"));
    }
    if (mode === "pending") {
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.tabsQuery.mockImplementationOnce(async () => {
        await pending;
        throw new Error("inventory unavailable");
      });
      const status = sendRuntimeMessage(h, { type: "getStatus" });
      release();
      await status;
    } else {
      await sendRuntimeMessage(h, { type: "getStatus" });
    }
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    if (mode === "inventory-detach" || mode === "no-socket") {
      await vi.waitFor(() => expect(h.debuggerDetach).toHaveBeenCalled());
    }
    if (mode === "retry" || mode === "fail-then-retry" || mode === "idempotent") {
      const detachCount = h.debuggerDetach.mock.calls.length;
      const status = await sendRuntimeMessage(h, { type: "getStatus" });
      expect(status).toMatchObject({ paired: false });
      if (mode === "idempotent") {
        await sendRuntimeMessage(h, { type: "getStatus" });
        expect(h.debuggerDetach.mock.calls.length).toBe(detachCount);
      }
    }
    if (mode === "re-pair") {
      const response = await sendRuntimeMessage(h, {
        type: "pair",
        pairingString: "ws://127.0.0.1:18798/extension#" + REPLACEMENT_TEST_RELAY_KEY,
        accessMode: "all",
      });
      expect(response).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(h.relaySockets.length).toBeGreaterThan(1));
    }
  });
});
