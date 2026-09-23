import { describe, expect, it } from "vitest";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import type {
  ConversationRef,
  SessionBindingRecord,
  SessionBindingService,
} from "./session-binding-service.js";

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
const resolve = (
  bindings: SessionBindingRecord[],
  requestedConversation: ConversationRef | undefined,
  failClosed: boolean,
) =>
  createBoundDeliveryRouter({
    listBySession: () => bindings,
  } as SessionBindingService).resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: sessionKey,
    requester: requestedConversation,
    failClosed,
  });

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
    name: "preserves permissive parent-child singleton fallback",
    bindings: [binding("child-thread", "parent-thread")],
    requestedConversation: requester("parent-thread"),
    failClosed: false,
    reason: "single-active-binding-fallback",
    bindingId: "runtime:child-thread",
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
  it.each(cases)("$name", ({ bindings, requestedConversation, failClosed, reason, bindingId }) => {
    const result = resolve(bindings, requestedConversation, failClosed);
    expect(result.reason).toBe(reason);
    expect(result.mode).toBe(bindingId ? "bound" : "fallback");
    expect(result.binding?.bindingId ?? null).toBe(bindingId);
  });

  it("keeps no-requester singleton fallback but rejects ambiguous multiples", () => {
    const sole = resolve([binding("thread-1")], undefined, false);
    expect(sole.reason).toBe("single-active-binding");
    expect(sole.binding?.bindingId).toBe("runtime:thread-1");
    const ambiguous = resolve([binding("thread-1"), binding("thread-2")], undefined, false);
    expect(ambiguous.reason).toBe("ambiguous-without-requester");
    expect(ambiguous.binding).toBeNull();
  });
});
