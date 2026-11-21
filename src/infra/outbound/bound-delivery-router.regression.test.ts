import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundDeliveryDestination } from "./bound-delivery-router.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding-service.js";

const listBindings = vi.hoisted(() => vi.fn());
vi.mock("./session-binding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-binding-service.js")>()),
  listSessionBindingsBySessionAsync: listBindings,
}));
beforeEach(() => listBindings.mockReset());

const sessionKey = "agent:main:subagent:bound-regression";
const binding = (
  conversationId: string,
  parentConversationId?: string,
  status: "active" | "inactive" = "active",
): SessionBindingRecord => ({
  bindingId: `runtime:${conversationId}`,
  targetSessionKey: sessionKey,
  targetKind: "subagent",
  conversation: { channel: "richchat", accountId: "runtime", conversationId, parentConversationId },
  status,
  boundAt: 1,
});
const requester = (
  conversationId: string,
  channel = "richchat",
  accountId = "runtime",
): ConversationRef => ({ channel, accountId, conversationId });
const resolve = async (
  bindings: SessionBindingRecord[],
  requestedConversation: ConversationRef | undefined,
  _failClosed: boolean,
) => {
  listBindings.mockResolvedValue(bindings);
  const binding = await resolveBoundDeliveryDestination({
    targetSessionKey: sessionKey,
    requester: requestedConversation,
  });
  return { binding };
};

type Case = {
  name: string;
  bindings: SessionBindingRecord[];
  requestedConversation?: ConversationRef;
  failClosed: boolean;
  reason: string;
  bindingId: string | null;
};
const cases: Case[] = [
  {
    name: "matches exact sole conversation when fail-closed",
    bindings: [binding("thread-1")],
    requestedConversation: requester("thread-1"),
    failClosed: true,
    reason: "requester-match",
    bindingId: "runtime:thread-1",
  },
  {
    name: "selects exact conversation among multiple bindings",
    bindings: [binding("thread-1"), binding("thread-2")],
    requestedConversation: requester("thread-2"),
    failClosed: true,
    reason: "requester-match",
    bindingId: "runtime:thread-2",
  },
  {
    name: "rejects different sole conversation when fail-closed",
    bindings: [binding("thread-1")],
    requestedConversation: requester("thread-3"),
    failClosed: true,
    reason: "no-requester-match",
    bindingId: null,
  },
  {
    name: "rejects a parent-child singleton without exact requester scope",
    bindings: [binding("child-thread", "parent-thread")],
    requestedConversation: requester("parent-thread"),
    failClosed: false,
    reason: "single-active-binding-fallback",
    bindingId: null,
  },
  {
    name: "rejects different conversation among multiple bindings",
    bindings: [binding("thread-1"), binding("thread-2")],
    requestedConversation: requester("thread-3"),
    failClosed: true,
    reason: "no-requester-match",
    bindingId: null,
  },
  {
    name: "rejects matching conversation under another account",
    bindings: [binding("thread-1")],
    requestedConversation: requester("thread-1", "richchat", "other-account"),
    failClosed: true,
    reason: "no-requester-match",
    bindingId: null,
  },
  {
    name: "rejects matching conversation under another channel",
    bindings: [binding("thread-1")],
    requestedConversation: requester("thread-1", "other-channel"),
    failClosed: true,
    reason: "no-requester-match",
    bindingId: null,
  },
  {
    name: "ignores inactive sole binding",
    bindings: [binding("thread-1", undefined, "inactive")],
    requestedConversation: requester("thread-1"),
    failClosed: true,
    reason: "no-active-binding",
    bindingId: null,
  },
  {
    name: "rejects missing requester when fail-closed",
    bindings: [binding("thread-1")],
    failClosed: true,
    reason: "missing-requester",
    bindingId: null,
  },
];

describe("bound delivery conversation isolation regression", () => {
  it.each(cases)("$name", async ({ bindings, requestedConversation, failClosed, bindingId }) => {
    const result = await resolve(bindings, requestedConversation, failClosed);
    expect(result.binding?.bindingId ?? null).toBe(bindingId);
  });

  it("rejects missing requester for single and multiple active bindings", async () => {
    expect((await resolve([binding("thread-1")], undefined, false)).binding).toBeNull();
    expect(
      (await resolve([binding("thread-1"), binding("thread-2")], undefined, false)).binding,
    ).toBeNull();
  });
});
