/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { flushStoredChatOutbox } from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  admitQueuedMessageForSession,
  subscribeChatOutboxProjection,
  keepVolatileQueuedMessage,
} from "./chat-queue.ts";
import { moveQueuedChatMessage } from "./chat-send-actions.ts";
import {
  listStoredChatOutboxes,
  admitStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItems,
} from "./composer-persistence.ts";

const SESSION_KEY = "agent:main";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(items: readonly Partial<ChatQueueItem>[], sessionKey = SESSION_KEY) {
  const host = makeChatHost({
    sessionKey,
    connected: false,
    requestHandlers: {},
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    },
  });
  const unsubscribe = subscribeChatOutboxProjection(host as never);
  items.forEach((item, index) => {
    const admitted = admitQueuedMessageForSession(
      host as never,
      captureChatOutboxAdmission(host, sessionKey, item.agentId),
      {
        id: `queued-${index + 1}`,
        text: `message ${index + 1}`,
        createdAt: 1_000 + index,
        sendState: "waiting-reconnect",
        sessionKey,
        ...item,
      },
    );
    expect(admitted).toBe(true);
  });
  return { host, unsubscribe };
}

/** The drain reads the stored outbox, so this is the delivery order, not a view. */
function storedOrder(host: unknown): string[] {
  return listStoredChatOutboxes(host as never).flatMap(({ queue }) => queue.map((item) => item.id));
}

describe("queued message reorder", () => {
  it("permutes ties between immutable equal-key barriers and survives a second pane/reload", () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1000, sendState: "unconfirmed" },
      { createdAt: 1000 },
      { createdAt: 1000 },
      { createdAt: 1000, sendState: "unconfirmed" },
    ]);
    const before = listStoredChatOutboxes(host)[0]!.queue;
    const peer = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
    const stopPeer = subscribeChatOutboxProjection(peer as never);
    try {
      expect(moveQueuedChatMessage(host as never, "queued-3", 0)).toBe("moved");
      const after = listStoredChatOutboxes(host)[0]!.queue;
      expect(after.map((row) => row.id)).toEqual(["queued-1", "queued-3", "queued-2", "queued-4"]);
      expect(after[0]).toEqual(before[0]);
      expect(after[3]).toEqual(before[3]);
      expect(sameQueuedDeliveryVersion(after[0]!, before[0]!)).toBe(true);
      expect(sameQueuedDeliveryVersion(after[3]!, before[3]!)).toBe(true);
      expect(peer.chatQueue.map((row) => row.id)).toEqual(after.map((row) => row.id));
      expect(storedOrder(makeChatHost({ sessionKey: SESSION_KEY }))).toEqual(
        after.map((row) => row.id),
      );
    } finally {
      stopPeer();
      unsubscribe();
    }
  });

  it("rejects a stale tied permutation even though every delivery version still matches", () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1000 },
      { createdAt: 1000 },
      { createdAt: 1000 },
    ]);
    const expected = listStoredChatOutboxes(host)[0]!.queue;
    expect(moveQueuedChatMessage(host as never, "queued-3", 0)).toBe("moved");
    expect(
      updateStoredChatComposerQueueItems(
        host,
        SESSION_KEY,
        expected.map((row) => ({ expected: row, next: row })),
        undefined,
        { expected: expected.map((row) => row.id), next: ["queued-2", "queued-1", "queued-3"] },
      ),
    ).toBe(false);
    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    unsubscribe();
  });

  it("retains an edited replacement at its equal-key source slot", () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1000 },
      { createdAt: 1000 },
      { createdAt: 1000 },
    ]);
    const source = listStoredChatOutboxes(host)[0]!.queue[1]!;
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, SESSION_KEY),
        { ...source, id: "replacement", text: "edited" },
        { id: source.id, expected: source },
      ),
    ).toBe(true);
    expect(storedOrder(host)).toEqual(["queued-1", "replacement", "queued-3"]);
    unsubscribe();
  });

  it.each([false, true])(
    "retains tied volatile slots through moves and refresh (mixed=%s)",
    (mixed) => {
      const { host, unsubscribe } = queueHost(
        mixed ? [{ createdAt: 1000 }, { createdAt: 1000 }] : [],
      );
      const owner = chatOutboxOwner(host);
      const scope = captureChatOutboxAdmission(host, SESSION_KEY).scope;
      const first: ChatQueueItem = {
        id: "volatile-1",
        text: "one",
        createdAt: 1000,
        sendState: "waiting-reconnect",
      };
      const second: ChatQueueItem = {
        id: "volatile-2",
        text: "two",
        createdAt: 1000,
        sendState: "waiting-reconnect",
      };
      keepVolatileQueuedMessage(host, SESSION_KEY, first, undefined, { retryable: true });
      keepVolatileQueuedMessage(host, SESSION_KEY, second, undefined, { retryable: true });
      expect(moveQueuedChatMessage(host as never, "volatile-2", 0)).toBe("moved");
      const wanted = mixed
        ? ["volatile-2", "queued-1", "queued-2", "volatile-1"]
        : ["volatile-2", "volatile-1"];
      expect(host.chatQueue.map((row) => row.id)).toEqual(wanted);
      owner.keep(host, scope, { ...second, text: "refreshed" }, true);
      expect(host.chatQueue.map((row) => row.id)).toEqual(wanted);
      if (mixed) {
        const peer = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
        const stopPeer = subscribeChatOutboxProjection(peer as never);
        expect(moveQueuedChatMessage(peer as never, "queued-2", 0)).toBe("moved");
        expect(host.chatQueue.map((row) => row.id)).toEqual([
          "volatile-2",
          "queued-2",
          "queued-1",
          "volatile-1",
        ]);
        stopPeer();
      }
      unsubscribe();
    },
  );

  it("rechecks tied head ownership after reset confirmation before dispatch", async () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1000, text: "/reset", localCommandName: "reset" },
      { createdAt: 1000 },
    ]);
    let resolveConfirmation!: (value: boolean) => void;
    host.confirmConversationReset = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    host.request.mockResolvedValue({
      messages: [],
      sessionInfo: { key: SESSION_KEY, hasActiveRun: false },
    });
    host.connected = true;
    const send = vi.fn(async (_host: unknown, _id: string) => {
      host.connected = false;
      return "pending" as const;
    });
    const draining = flushStoredChatOutbox(host as never, {
      sendQueuedChatMessage: send,
      sendResetSlashCommand: vi.fn(async () => {}),
      setChatError: vi.fn(),
    });
    expect(host.confirmConversationReset).toHaveBeenCalledOnce();
    expect(moveQueuedChatMessage(host as never, "queued-2", 0)).toBe("moved");
    resolveConfirmation(true);
    await draining;
    expect(send.mock.calls.map((call) => call[1])).toEqual(["queued-2"]);
    unsubscribe();
  });

  it("rechecks tied head ownership after delayed history before dispatch", async () => {
    const { host, unsubscribe } = queueHost([{ createdAt: 1000 }, { createdAt: 1000 }]);
    const idle = { messages: [], sessionInfo: { key: SESSION_KEY, hasActiveRun: false } };
    let resolveHistory!: (value: typeof idle) => void;
    const pending = new Promise<typeof idle>((resolve) => {
      resolveHistory = resolve;
    });
    host.request.mockImplementationOnce(() => pending).mockResolvedValue(idle);
    host.connected = true;
    const send = vi.fn(async (_host: unknown, _id: string) => {
      host.connected = false;
      return "pending" as const;
    });
    const draining = flushStoredChatOutbox(host as never, {
      sendQueuedChatMessage: send,
      sendResetSlashCommand: vi.fn(async () => {}),
      setChatError: vi.fn(),
    });
    expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything());
    expect(moveQueuedChatMessage(host as never, "queued-2", 0)).toBe("moved");
    resolveHistory(idle);
    await draining;
    expect(send.mock.calls.map((call) => call[1])).toEqual(["queued-2"]);
    unsubscribe();
  });

  it("reorders the captured inactive outbox after current main defaults change", () => {
    const { host: fixture, unsubscribe } = queueHost([{}, {}], "agent:main:main");
    const host = Object.assign(fixture, {
      settings: {
        ...loadSettings(),
        ...fixture.settings,
        gatewayUrl: fixture.settings.gatewayUrl ?? "",
      },
    });
    try {
      host.sessionKey = "agent:main:other";
      host.agentsList = {
        defaultId: "main",
        mainKey: "workspace",
        scope: "per-sender",
        agents: [{ id: "main" }],
      };
      expect(moveQueuedChatMessage(host, "queued-2", 0)).toBe("moved");
      expect(listStoredChatOutboxes(host)).toMatchObject([
        {
          sessionKey: "agent:main:main",
          agentId: "main",
          queue: [{ id: "queued-2" }, { id: "queued-1" }],
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("moves a row to the head of both the visible queue and the stored outbox", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("survives a reload, because the position is stored with the message", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    moveQueuedChatMessage(host as never, "queued-3", 0);
    unsubscribe();

    const reloaded = makeChatHost({ sessionKey: SESSION_KEY, connected: false });

    expect(storedOrder(reloaded)).toEqual(["queued-3", "queued-1", "queued-2"]);
  });

  it("leaves a row that already joined a run where it is", () => {
    const { host, unsubscribe } = queueHost([{ sendState: "unconfirmed" }, {}, {}]);

    moveQueuedChatMessage(host as never, "queued-1", 2);
    moveQueuedChatMessage(host as never, "queued-3", 0);

    // The unconfirmed row keeps the head; only the two movable rows swap.
    expect(storedOrder(host)).toEqual(["queued-1", "queued-3", "queued-2"]);
    unsubscribe();
  });

  it("moves a row that shares its arrival millisecond with the whole queue", () => {
    // Equal arrivals would otherwise share one position value and swallow the
    // move, leaving the drain on its old head while the list looked reordered.
    const { host, unsubscribe } = queueHost([
      { createdAt: 1_000 },
      { createdAt: 1_000 },
      { createdAt: 1_000 },
    ]);

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    unsubscribe();
  });

  it("refuses to deliver a row ahead of a locked row in the middle", () => {
    const { host, unsubscribe } = queueHost([{}, { sendState: "unconfirmed" }, {}, {}]);

    // The drain stops on the locked head, so reaching index 0 from behind it
    // would send a message the operator queued later than pending delivery.
    moveQueuedChatMessage(host as never, "queued-4", 0);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-4", "queued-3"]);
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("keeps tied arrivals ahead of their delivery-uncertain barrier when reordered", () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1_000 },
      { createdAt: 1_000 },
      { createdAt: 1_000, sendState: "unconfirmed" },
      { createdAt: 1_001 },
    ]);
    try {
      expect(moveQueuedChatMessage(host as never, "queued-2", 0)).toBe("moved");
      expect(storedOrder(host)).toEqual(["queued-2", "queued-1", "queued-3", "queued-4"]);
      expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    } finally {
      unsubscribe();
    }
  });

  it("commits a multi-row reorder as one durable write instead of a partial permutation", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    let writes = 0;
    // Permits exactly one write to land, then fails every write after it. A
    // per-row write loop would apply the first changed row and get stuck mid
    // permutation; a single batch write either lands the whole reorder or none of it.
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes > 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      originalSetItem(key, value);
    });

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(writes).toBe(1);
    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("leaves the durable and visible order unchanged when the batch write fails", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).not.toBeNull();
    unsubscribe();
  });

  it("rejects a two-row batch instead of committing a mixed permutation when one row went stale", () => {
    // `moveQueuedChatMessage` always re-reads storage immediately before it
    // writes, so it can never observe a mid-flight race by itself. This test
    // exercises the batch CAS primitive directly with a snapshot captured
    // before a concurrent write lands, which is what a real cross-tab race
    // looks like: the caller's `expected` rows were read before the other
    // writer's commit, then presented to the write after it.
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    unsubscribe();

    const storedById = (id: string) =>
      listStoredChatOutboxes(host as never)
        .flatMap(({ queue }) => queue)
        .find((entry) => entry.id === id)!;
    // Snapshot taken "before" the concurrent write, matching what a caller
    // would have read prior to another writer's commit.
    const expectedQueued2 = storedById("queued-2");
    const expectedQueued3 = storedById("queued-3");

    // A second tab/writer lands a durable change to queued-2 (a retry attempt
    // bump) after that snapshot was taken.
    const concurrentWrite = updateStoredChatComposerQueueItem(
      host as never,
      SESSION_KEY,
      expectedQueued2,
      {
        ...expectedQueued2,
        sendAttempts: (expectedQueued2.sendAttempts ?? 0) + 1,
      },
    );
    expect(concurrentWrite).toBe(true);

    // The reorder permutation this batch represents: an adjacent swap that
    // changes exactly queued-2 and queued-3's orderKey and leaves queued-1
    // untouched, mirroring what `moveQueuedChatMessage("queued-3", 1)` computes.
    const applied = updateStoredChatComposerQueueItems(host as never, SESSION_KEY, [
      {
        expected: expectedQueued3,
        next: { ...expectedQueued3, orderKey: expectedQueued2.createdAt },
      },
      {
        expected: expectedQueued2,
        next: { ...expectedQueued2, orderKey: expectedQueued3.createdAt },
      },
    ]);

    // queued-3's own compare-and-set would have succeeded alone; the batch must
    // still reject in full because its sibling row, queued-2, went stale using
    // the pre-concurrent-write snapshot. Any stored order other than the
    // untouched original (aside from the concurrent writer's own sendAttempts
    // bump) would mean the batch committed part of the permutation.
    expect(applied).toBe(false);
    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(storedById("queued-3").orderKey).toBe(expectedQueued3.orderKey);
    expect(storedById("queued-2").sendAttempts).toBe((expectedQueued2.sendAttempts ?? 0) + 1);
  });
});
