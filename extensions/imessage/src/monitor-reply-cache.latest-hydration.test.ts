import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type ReplyCache = typeof import("./monitor-reply-cache.js");
let cache: ReplyCache;

beforeEach(async () => {
  cache = await loadFreshIMessageReplyCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function restart(): Promise<void> {
  cache = await loadFreshIMessageReplyCacheForTest({ preservePersistentState: true });
}

function remember(
  messageId: string,
  options: Partial<Parameters<ReplyCache["rememberIMessageReplyCache"]>[0]> = {},
): void {
  cache.rememberIMessageReplyCache({
    accountId: "default",
    messageId,
    chatGuid: "iMessage;+;chatA",
    timestamp: Date.now(),
    ...options,
  });
}

describe("iMessage latest-message cold-cache hydration regression pack", () => {
  it("I01 resolves one persisted same-chat message after restart", async () => {
    remember("persisted-one");
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      })?.messageId,
    ).toBe("persisted-one");
  });

  it("I02 selects the newest of two persisted same-chat messages", async () => {
    remember("older", { timestamp: Date.now() - 5_000 });
    remember("newer", { timestamp: Date.now() - 1_000 });
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      })?.messageId,
    ).toBe("newer");
  });

  it("I03 warm cache continues to select a newly received later message", async () => {
    remember("persisted");
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      })?.messageId,
    ).toBe("persisted");
    remember("live", { timestamp: Date.now() + 1 });
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      })?.messageId,
    ).toBe("live");
  });

  it("I04 excludes a persisted message from another account", async () => {
    remember("foreign-account", { accountId: "other" });
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I05 excludes a persisted message from another chat", async () => {
    remember("foreign-chat", { chatGuid: "iMessage;+;chatB" });
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I06 requires a positive overlapping chat identifier after hydration", async () => {
    remember("only-guid");
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatId: 42,
      }),
    ).toBeUndefined();
  });

  it("I07 excludes a persisted entry outside the ten-minute latest window", async () => {
    remember("too-old", { timestamp: Date.now() - 11 * 60 * 1_000 });
    await restart();
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I08 missing chat scope returns before opening persistence", async () => {
    remember("persisted");
    await restart();
    const runtime = await import("./runtime.js");
    const open = vi.spyOn(runtime.getIMessageRuntime().state, "openSyncKeyedStore");
    expect(cache.findLatestIMessageEntryForChat({ accountId: "default" })).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it("I09 missing account id returns before opening persistence", async () => {
    remember("persisted");
    await restart();
    const runtime = await import("./runtime.js");
    const open = vi.spyOn(runtime.getIMessageRuntime().state, "openSyncKeyedStore");
    expect(
      cache.findLatestIMessageEntryForChat({
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it("I10 persistence read failure remains a safe undefined fallback", async () => {
    const runtime = await import("./runtime.js");
    const active = runtime.getIMessageRuntime();
    runtime.setIMessageRuntime({
      ...active,
      state: {
        ...active.state,
        openSyncKeyedStore: () => {
          throw new Error("test persistence read failure");
        },
      },
    } as never);
    expect(
      cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });
});
