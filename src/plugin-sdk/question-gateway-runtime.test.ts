import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuestionReactionTargetStore } from "./question-gateway-runtime.js";

type RegisterChannelDelivery =
  typeof import("../infra/question-channel-runtime.js").registerQuestionChannelDelivery;
type ResolveReaction =
  typeof import("../infra/question-reaction-runtime.js").resolveQuestionReactionOverGateway;

const binding = {
  questionId: "ask_0123456789abcdef0123456789abcdef",
  optionValues: ["One", "Two"],
};

function createStore(
  overrides: {
    ttlMs?: number;
    registerChannelDelivery?: RegisterChannelDelivery;
    resolveReaction?: ResolveReaction;
  } = {},
) {
  return createQuestionReactionTargetStore({
    channel: "test",
    channelDisplayName: "Test",
    ttlMs: overrides.ttlMs,
    buildKey: (identity: { accountId: string; messageId: string }) => {
      const accountId = identity.accountId.trim();
      const messageId = identity.messageId.trim();
      return accountId && messageId ? `${accountId}:${messageId}` : null;
    },
    registerChannelDelivery: overrides.registerChannelDelivery,
    resolveReaction: overrides.resolveReaction,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createQuestionReactionTargetStore", () => {
  it("replaces target timers without letting the old timer delete the new target", () => {
    vi.useFakeTimers();
    const store = createStore({
      ttlMs: 1_000,
      registerChannelDelivery: vi.fn<RegisterChannelDelivery>(),
    });
    const identity = { accountId: "default", messageId: "message-1" };

    expect(store.register(binding, identity)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(store.register(binding, identity)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(store.has([identity])).toBe(true);
    vi.advanceTimersByTime(500);
    expect(store.has([identity])).toBe(false);
  });

  it("registers the exact delivery id and honors synchronous finalization", async () => {
    const registerChannelDelivery = vi.fn<RegisterChannelDelivery>((params) => {
      void params.finalize("answered");
    });
    const resolveReaction = vi.fn<ResolveReaction>();
    const store = createStore({ registerChannelDelivery, resolveReaction });
    const identity = { accountId: "default", messageId: "message-1" };
    const logDebug = vi.fn();

    expect(store.register(binding, identity)).toBe(true);
    expect(registerChannelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: binding.questionId,
        deliveryId: "test-reaction:default:message-1",
      }),
    );
    await expect(
      store.resolve({
        identities: [identity],
        optionIndex: 0,
        cfg: {},
        senderId: "sender-1",
        logDebug,
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      `test: stale question reaction ignored id=${binding.questionId}`,
    );
  });

  it("resolves once, terminalizes the target, and consumes later duplicates", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({
      status: "answered",
      questionId: "choice",
      optionValue: "Two",
    });
    const store = createStore({
      registerChannelDelivery: vi.fn<RegisterChannelDelivery>(),
      resolveReaction,
    });
    const identity = { accountId: "default", messageId: "message-1" };
    store.register(binding, identity);

    const resolveParams = {
      identities: [identity],
      optionIndex: 1,
      cfg: {},
      senderId: "sender-1",
      gatewayUrl: "ws://127.0.0.1:1234",
      logDebug: vi.fn(),
    };
    await expect(store.resolve(resolveParams)).resolves.toBe(true);
    await expect(store.resolve(resolveParams)).resolves.toBe(true);

    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith({
      cfg: {},
      questionId: binding.questionId,
      optionValue: "Two",
      senderId: "sender-1",
      gatewayUrl: "ws://127.0.0.1:1234",
      clientDisplayName: "Test question (sender-1)",
    });
    expect(resolveParams.logDebug).toHaveBeenCalledWith(
      `test: stale question reaction ignored id=${binding.questionId}`,
    );
  });

  it("consumes out-of-range choices and resolver failures without losing diagnostics", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockRejectedValue(new Error("gateway down"));
    const store = createStore({
      registerChannelDelivery: vi.fn<RegisterChannelDelivery>(),
      resolveReaction,
    });
    const outOfRange = { accountId: "default", messageId: "out-of-range" };
    const failure = { accountId: "default", messageId: "failure" };
    const logDebug = vi.fn();
    store.register(binding, outOfRange);
    store.register(binding, failure);

    await expect(
      store.resolve({
        identities: [outOfRange],
        optionIndex: 3,
        cfg: {},
        senderId: "sender-1",
        logDebug,
      }),
    ).resolves.toBe(true);
    await expect(
      store.resolve({
        identities: [failure],
        optionIndex: 0,
        cfg: {},
        senderId: "sender-1",
        logDebug,
      }),
    ).resolves.toBe(true);

    expect(logDebug).toHaveBeenCalledWith(
      `test: out-of-range question reaction ignored id=${binding.questionId}`,
    );
    expect(logDebug).toHaveBeenCalledWith(
      `test: question reaction failed id=${binding.questionId}: Error: gateway down`,
    );
  });
});

describe("reaction candidate selection", () => {
  it("skips a terminal first identity for a later live question", async () => {
    const finalizers = new Map<string, (status: "answered") => void>();
    const registerChannelDelivery = vi.fn<RegisterChannelDelivery>((params) => {
      finalizers.set(params.questionId, params.finalize);
    });
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({
      status: "answered",
      questionId: "live",
      optionValue: "One",
    });
    const store = createStore({ registerChannelDelivery, resolveReaction });
    const stale = { accountId: "default", messageId: "stale" };
    const live = { accountId: "default", messageId: "live" };
    store.register({ ...binding, questionId: "stale" }, stale);
    store.register({ ...binding, questionId: "live" }, live);
    finalizers.get("stale")?.("answered");

    await expect(
      store.resolve({
        identities: [stale, live],
        optionIndex: 0,
        cfg: {},
        senderId: "sender-1",
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: "live", optionValue: "One" }),
    );
  });

  it("resolves one live identity", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({ status: "answered" });
    const store = createStore({ registerChannelDelivery: vi.fn(), resolveReaction });
    const live = { accountId: "default", messageId: "live" };
    store.register({ ...binding, questionId: "live" }, live);
    await expect(
      store.resolve({ identities: [live], optionIndex: 1, cfg: {}, senderId: "sender" }),
    ).resolves.toBe(true);
    expect(resolveReaction).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: "live", optionValue: "Two" }),
    );
  });

  it("prefers the first live identity of two", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({ status: "answered" });
    const store = createStore({ registerChannelDelivery: vi.fn(), resolveReaction });
    const first = { accountId: "default", messageId: "first" };
    const second = { accountId: "default", messageId: "second" };
    store.register({ ...binding, questionId: "first" }, first);
    store.register({ ...binding, questionId: "second" }, second);
    await store.resolve({
      identities: [first, second],
      optionIndex: 0,
      cfg: {},
      senderId: "sender",
    });
    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith(expect.objectContaining({ questionId: "first" }));
  });

  it("skips an expired first identity for a later live question", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({ status: "answered" });
    const store = createStore({ ttlMs: 1_000, registerChannelDelivery: vi.fn(), resolveReaction });
    const expired = { accountId: "default", messageId: "expired" };
    const live = { accountId: "default", messageId: "live" };
    store.register({ ...binding, questionId: "expired" }, expired);
    vi.setSystemTime(1_001);
    store.register({ ...binding, questionId: "live" }, live);
    await store.resolve({
      identities: [expired, live],
      optionIndex: 0,
      cfg: {},
      senderId: "sender",
    });
    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith(expect.objectContaining({ questionId: "live" }));
  });

  it("skips a metadata mismatch for a later matching live identity", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({ status: "answered" });
    const store = createQuestionReactionTargetStore({
      channel: "test",
      channelDisplayName: "Test",
      buildKey: (identity: string) => identity,
      identityMatches: (stored: string | undefined, incoming: string | undefined) =>
        stored === incoming,
      registerChannelDelivery: vi.fn(),
      resolveReaction,
    });
    store.register({ ...binding, questionId: "wrong" }, "wrong", "other");
    store.register({ ...binding, questionId: "right" }, "right", "expected");
    await expect(
      store.resolve({
        identities: ["wrong", "right"],
        metadata: "expected",
        optionIndex: 0,
        cfg: {},
        senderId: "sender",
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith(expect.objectContaining({ questionId: "right" }));
  });

  it("handles all stale identities without calling the resolver", async () => {
    const finalizers = new Map<string, (status: "answered") => void>();
    const resolveReaction = vi.fn<ResolveReaction>();
    const store = createStore({
      registerChannelDelivery: vi.fn<RegisterChannelDelivery>((params) => {
        finalizers.set(params.questionId, params.finalize);
      }),
      resolveReaction,
    });
    const first = { accountId: "default", messageId: "first" };
    const second = { accountId: "default", messageId: "second" };
    store.register({ ...binding, questionId: "first" }, first);
    store.register({ ...binding, questionId: "second" }, second);
    finalizers.get("first")?.("answered");
    finalizers.get("second")?.("answered");
    const logDebug = vi.fn();
    await expect(
      store.resolve({
        identities: [first, second],
        optionIndex: 0,
        cfg: {},
        senderId: "sender",
        logDebug,
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith("test: stale question reaction ignored id=first");
  });

  it("returns false when all identities are missing", async () => {
    const resolveReaction = vi.fn<ResolveReaction>();
    const store = createStore({ registerChannelDelivery: vi.fn(), resolveReaction });
    await expect(
      store.resolve({
        identities: [{ accountId: "default", messageId: "missing" }],
        optionIndex: 0,
        cfg: {},
        senderId: "sender",
      }),
    ).resolves.toBe(false);
    expect(resolveReaction).not.toHaveBeenCalled();
  });

  it("resolves duplicate identities only once", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({ status: "answered" });
    const store = createStore({ registerChannelDelivery: vi.fn(), resolveReaction });
    const live = { accountId: "default", messageId: "live" };
    store.register(binding, live);
    await store.resolve({ identities: [live, live], optionIndex: 0, cfg: {}, senderId: "sender" });
    expect(resolveReaction).toHaveBeenCalledOnce();
  });

  it("consumes an out-of-range choice on the selected live question", async () => {
    const finalizers = new Map<string, (status: "answered") => void>();
    const resolveReaction = vi.fn<ResolveReaction>();
    const store = createStore({
      registerChannelDelivery: vi.fn<RegisterChannelDelivery>((params) => {
        finalizers.set(params.questionId, params.finalize);
      }),
      resolveReaction,
    });
    const stale = { accountId: "default", messageId: "stale" };
    const live = { accountId: "default", messageId: "live" };
    store.register({ ...binding, questionId: "stale" }, stale);
    store.register({ ...binding, questionId: "live" }, live);
    finalizers.get("stale")?.("answered");
    const logDebug = vi.fn();
    await expect(
      store.resolve({
        identities: [stale, live],
        optionIndex: 3,
        cfg: {},
        senderId: "sender",
        logDebug,
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith("test: out-of-range question reaction ignored id=live");
  });

  it("reports a resolver error without trying a second candidate", async () => {
    const resolveReaction = vi.fn<ResolveReaction>().mockRejectedValue(new Error("gateway down"));
    const store = createStore({ registerChannelDelivery: vi.fn(), resolveReaction });
    const first = { accountId: "default", messageId: "first" };
    const second = { accountId: "default", messageId: "second" };
    store.register({ ...binding, questionId: "first" }, first);
    store.register({ ...binding, questionId: "second" }, second);
    const logDebug = vi.fn();
    await expect(
      store.resolve({
        identities: [first, second],
        optionIndex: 0,
        cfg: {},
        senderId: "sender",
        logDebug,
      }),
    ).resolves.toBe(true);
    expect(resolveReaction).toHaveBeenCalledOnce();
    expect(resolveReaction).toHaveBeenCalledWith(expect.objectContaining({ questionId: "first" }));
    expect(logDebug).toHaveBeenCalledWith(
      "test: question reaction failed id=first: Error: gateway down",
    );
  });
});
