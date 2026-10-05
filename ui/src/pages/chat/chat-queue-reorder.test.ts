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
import { admitQueuedMessageForSession, keepVolatileQueuedMessage } from "./chat-queue.ts";
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
  const unsubscribe = chatOutboxOwner(host as never).subscribe(host as never);
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
      { createdAt: 1000, orderKey: 1000, sendState: "unconfirmed" },
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000, sendState: "unconfirmed" },
    ]);
    const before = listStoredChatOutboxes(host)[0]!.queue;
    const peer = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
    const stopPeer = chatOutboxOwner(peer as never).subscribe(peer as never);
    try {
      expect(moveQueuedChatMessage(host as never, "queued-3", "queued-2")).toBe("moved");
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
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000 },
    ]);
    const expected = listStoredChatOutboxes(host)[0]!.queue;
    expect(moveQueuedChatMessage(host as never, "queued-3", "queued-1")).toBe("moved");
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
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000 },
      { createdAt: 1000, orderKey: 1000 },
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
        mixed ? [{ createdAt: 1000, orderKey: 1000 }, { createdAt: 1000, orderKey: 1000 }] : [],
      );
      const owner = chatOutboxOwner(host);
      const scope = captureChatOutboxAdmission(host, SESSION_KEY).scope;
      const first: ChatQueueItem = {
        id: "volatile-1",
        text: "one",
        createdAt: 1000,
        orderKey: 1000,
        sendState: "waiting-reconnect",
      };
      const second: ChatQueueItem = {
        id: "volatile-2",
        text: "two",
        createdAt: 1000,
        orderKey: 1000,
        sendState: "waiting-reconnect",
      };
      keepVolatileQueuedMessage(host, SESSION_KEY, first, undefined, { retryable: true });
      keepVolatileQueuedMessage(host, SESSION_KEY, second, undefined, { retryable: true });
      expect(moveQueuedChatMessage(host as never, "volatile-2", mixed ? "queued-1" : "volatile-1")).toBe("moved");
      const wanted = mixed
        ? ["volatile-2", "queued-1", "queued-2", "volatile-1"]
        : ["volatile-2", "volatile-1"];
      expect(host.chatQueue.map((row) => row.id)).toEqual(wanted);
      owner.keep(host, scope, { ...second, text: "refreshed" }, true);
      expect(host.chatQueue.map((row) => row.id)).toEqual(wanted);
      if (mixed) {
        const peer = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
        const stopPeer = chatOutboxOwner(peer as never).subscribe(peer as never);
        expect(moveQueuedChatMessage(peer as never, "queued-2", "queued-1")).toBe("moved");
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
      { createdAt: 1000, orderKey: 1000, text: "/reset", localCommandName: "reset" },
      { createdAt: 1000, orderKey: 1000 },
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
    expect(moveQueuedChatMessage(host as never, "queued-2", "queued-1")).toBe("moved");
    resolveConfirmation(true);
    await draining;
    expect(send.mock.calls.map((call) => call[1])).toEqual(["queued-2"]);
    unsubscribe();
  });

  it("rechecks tied head ownership after delayed history before dispatch", async () => {
    const { host, unsubscribe } = queueHost([{ createdAt: 1000, orderKey: 1000 }, { createdAt: 1000, orderKey: 1000 }]);
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
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    expect(moveQueuedChatMessage(host as never, "queued-2", "queued-1")).toBe("moved");
    resolveHistory(idle);
    await draining;
    expect(send.mock.calls.map((call) => call[1])).toEqual(["queued-2"]);
    unsubscribe();
  });

  it("retains equal-time arrival order when an earlier local row changes state", () => {
    const { host, unsubscribe } = queueHost([]);
    const owner = chatOutboxOwner(host);
    const scope = captureChatOutboxAdmission(host, host.sessionKey).scope;
    const first: ChatQueueItem = { id: "first", text: "first", createdAt: 1_000 };
    const second: ChatQueueItem = { id: "second", text: "second", createdAt: 1_000 };
    try {
      owner.keep(host, scope, first);
      owner.keep(host, scope, second);
      owner.keep(host, scope, { ...first, sendState: "waiting-model" });

      expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);
    } finally {
      unsubscribe();
    }
  });

  it("retains equal-time arrival order when a later row reaches storage first", () => {
    const { host, unsubscribe } = queueHost([]);
    const owner = chatOutboxOwner(host);
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    const first: ChatQueueItem = { id: "first", text: "first", createdAt: 1_000 };
    const second: ChatQueueItem = { id: "second", text: "second", createdAt: 1_000 };
    try {
      owner.keep(host, admission.scope, first);
      owner.keep(host, admission.scope, second);
      expect(owner.admit(host, admission, second)).toBe("admitted");
      expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);

      expect(owner.admit(host, admission, first)).toBe("admitted");
      expect(storedOrder(host)).toEqual(["first", "second"]);
    } finally {
      unsubscribe();
    }
  });

  it.each([1_000, 900])(
    "appends a new arrival at time %i after the operator's reordered queue",
    (createdAt) => {
      const { host, unsubscribe } = queueHost([
        { createdAt: 1_000, orderKey: 1_000 },
        { createdAt: 1_000, orderKey: 1_000 },
        { createdAt: 1_000, orderKey: 1_000 },
      ]);
      try {
        moveQueuedChatMessage(host, "queued-3", "queued-1");
        expect(
          chatOutboxOwner(host).admit(host, captureChatOutboxAdmission(host, host.sessionKey), {
            id: "latest",
            text: "latest",
            createdAt,
          }),
        ).toBe("admitted");

        expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2", "latest"]);
        expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
      } finally {
        unsubscribe();
      }
    },
  );

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
      expect(moveQueuedChatMessage(host, "queued-2", "queued-1")).toBe("moved");
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

  it("survives a reload, because the position is stored with the message", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    moveQueuedChatMessage(host as never, "queued-3", "queued-1");
    unsubscribe();

    const reloaded = makeChatHost({ sessionKey: SESSION_KEY, connected: false });

    expect(storedOrder(reloaded)).toEqual(["queued-3", "queued-1", "queued-2"]);
  });

  it("leaves a row that already joined a run where it is", () => {
    const { host, unsubscribe } = queueHost([{ sendState: "unconfirmed" }, {}, {}]);

    moveQueuedChatMessage(host as never, "queued-1", "queued-3");
    moveQueuedChatMessage(host as never, "queued-3", "queued-2");

    // The unconfirmed row keeps the head; only the two movable rows swap.
    expect(storedOrder(host)).toEqual(["queued-1", "queued-3", "queued-2"]);
    unsubscribe();
  });

  it("moves a row that shares its arrival millisecond with the whole queue", () => {
    // Equal arrivals would otherwise share one position value and swallow the
    // move, leaving the drain on its old head while the list looked reordered.
    const { host, unsubscribe } = queueHost([
      { createdAt: 1_000, orderKey: 1_000 },
      { createdAt: 1_000, orderKey: 1_000 },
      { createdAt: 1_000, orderKey: 1_000 },
    ]);

    moveQueuedChatMessage(host as never, "queued-3", "queued-1");

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    unsubscribe();
  });

  it("refuses to deliver a row ahead of a locked row in the middle", () => {
    const { host, unsubscribe } = queueHost([{}, { sendState: "unconfirmed" }, {}, {}]);

    expect(moveQueuedChatMessage(host as never, "queued-4", "queued-1")).toBe("noop");
    moveQueuedChatMessage(host as never, "queued-4", "queued-3");

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-4", "queued-3"]);
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("keeps tied arrivals ahead of their delivery-uncertain barrier when reordered", () => {
    const { host, unsubscribe } = queueHost([
      { createdAt: 1_000, orderKey: 1_000 },
      { createdAt: 1_000, orderKey: 1_000 },
      { createdAt: 1_000, orderKey: 1_000, sendState: "unconfirmed" },
      { createdAt: 1_001 },
    ]);
    try {
      expect(moveQueuedChatMessage(host as never, "queued-2", "queued-1")).toBe("moved");
      expect(storedOrder(host)).toEqual(["queued-2", "queued-1", "queued-3", "queued-4"]);
      expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    } finally {
      unsubscribe();
    }
  });

  it("does not move an equal-time stored row across the following delivery barrier", () => {
    const { host, unsubscribe } = queueHost([]);
    try {
      for (const id of ["first", "second", "locked"]) {
        expect(
          admitStoredChatComposerQueueItem(
            host,
            captureChatOutboxAdmission(host, host.sessionKey),
            {
              id,
              text: id,
              createdAt: 1_000,
              sendState: id === "locked" ? "unconfirmed" : "waiting-reconnect",
            },
          ),
        ).toBe(true);
      }

      moveQueuedChatMessage(host, "second", "first");

      expect(storedOrder(host).at(-1)).toBe("locked");
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

    moveQueuedChatMessage(host as never, "queued-3", "queued-1");

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

    moveQueuedChatMessage(host as never, "queued-3", "queued-1");

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).not.toBeNull();
    unsubscribe();
  });

  it("rejects a two-row batch instead of committing a mixed permutation when one row went stale", () => {
    // Reorder rereads storage synchronously; capture stale rows at the CAS boundary
    // to simulate a second tab writing between the original read and commit.
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    unsubscribe();

    const storedById = (id: string) =>
      listStoredChatOutboxes(host as never)
        .flatMap(({ queue }) => queue)
        .find((entry) => entry.id === id)!;
    const expectedQueued2 = storedById("queued-2");
    const expectedQueued3 = storedById("queued-3");

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

    // queued-3 would succeed alone, but its stale sibling rejects the whole batch.
    expect(applied).toBe(false);
    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(storedById("queued-3").orderKey).toBe(expectedQueued3.orderKey);
    expect(storedById("queued-2").sendAttempts).toBe((expectedQueued2.sendAttempts ?? 0) + 1);
  });
});
