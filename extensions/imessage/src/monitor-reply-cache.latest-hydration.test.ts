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

async function remember(
  messageId: string,
  options: Partial<Parameters<ReplyCache["rememberIMessageReplyCache"]>[0]> = {},
): Promise<void> {
  await cache.rememberIMessageReplyCache({
    accountId: "default",
    messageId,
    chatGuid: "iMessage;+;chatA",
    timestamp: Date.now(),
    ...options,
  });
}

describe("iMessage latest-message cold-cache hydration regression pack", () => {
  it("I01 resolves one persisted same-chat message after restart", async () => {
    await remember("persisted-one");
    await restart();
    expect(
      (
        await cache.findLatestIMessageEntryForChat({
          accountId: "default",
          chatGuid: "iMessage;+;chatA",
        })
      )?.messageId,
    ).toBe("persisted-one");
  });

  it("I02 selects the newest of two persisted same-chat messages", async () => {
    await remember("older", { timestamp: Date.now() - 5_000 });
    await remember("newer", { timestamp: Date.now() - 1_000 });
    await restart();
    expect(
      (
        await cache.findLatestIMessageEntryForChat({
          accountId: "default",
          chatGuid: "iMessage;+;chatA",
        })
      )?.messageId,
    ).toBe("newer");
  });

  it("I03 warm cache continues to select a newly received later message", async () => {
    await remember("persisted");
    await restart();
    expect(
      (
        await cache.findLatestIMessageEntryForChat({
          accountId: "default",
          chatGuid: "iMessage;+;chatA",
        })
      )?.messageId,
    ).toBe("persisted");
    await remember("live", { timestamp: Date.now() + 1 });
    expect(
      (
        await cache.findLatestIMessageEntryForChat({
          accountId: "default",
          chatGuid: "iMessage;+;chatA",
        })
      )?.messageId,
    ).toBe("live");
  });

  it("I04 excludes a persisted message from another account", async () => {
    await remember("foreign-account", { accountId: "other" });
    await restart();
    expect(
      await cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I05 excludes a persisted message from another chat", async () => {
    await remember("foreign-chat", { chatGuid: "iMessage;+;chatB" });
    await restart();
    expect(
      await cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I06 requires a positive overlapping chat identifier after hydration", async () => {
    await remember("only-guid");
    await restart();
    expect(
      await cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatId: 42,
      }),
    ).toBeUndefined();
  });

  it("I07 excludes a persisted entry outside the ten-minute latest window", async () => {
    await remember("too-old", { timestamp: Date.now() - 11 * 60 * 1_000 });
    await restart();
    expect(
      await cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });

  it("I08 missing chat scope returns before opening persistence", async () => {
    await remember("persisted");
    await restart();
    const runtime = await import("./runtime.js");
    const open = vi.spyOn(runtime.getIMessageRuntime().state, "openKeyedStoreV2");
    expect(await cache.findLatestIMessageEntryForChat({ accountId: "default" })).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it("I09 missing account id returns before opening persistence", async () => {
    await remember("persisted");
    await restart();
    const runtime = await import("./runtime.js");
    const open = vi.spyOn(runtime.getIMessageRuntime().state, "openKeyedStoreV2");
    expect(
      await cache.findLatestIMessageEntryForChat({
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
        openKeyedStoreV2: () => {
          throw new Error("test persistence read failure");
        },
      },
    } as never);
    expect(
      await cache.findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "iMessage;+;chatA",
      }),
    ).toBeUndefined();
  });
});
