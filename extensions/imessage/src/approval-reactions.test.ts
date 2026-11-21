// Preserve local actor-identity protection after upstream consolidated approval tests.
import { beforeEach, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

const gateway = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolve,
}));

let reactions: typeof import("./approval-reactions.js");
const conversation = { chatGuid: "iMessage;+;fallback-group" };
const identity = {
  accountId: "default",
  conversation,
  messageId: "approval-message",
  approvalId: "exec-local-fallback",
  approvalKind: "exec" as const,
  allowedDecisions: ["allow-once", "deny"] as const,
};
const cfg = { channels: { imessage: { allowFrom: ["+15551230000"] } } };

beforeEach(async () => {
  await loadFreshIMessageReplyCacheForTest();
  reactions = await import("./approval-reactions.js");
  gateway.resolve.mockReset().mockResolvedValue({
    applied: true,
    approval: { status: "allowed", decision: "allow-once", reason: "user" },
  });
  await reactions.registerIMessageApprovalReactionTarget(identity);
});

it.each([false, undefined, null])(
  "rejects a received local-account sender fallback when is_from_me=%s",
  async (isFromMe) => {
    await expect(
      reactions.maybeResolveIMessageApprovalReaction({
        cfg,
        accountId: "default",
        bodyText: "",
        message: {
          sender: "+15551230000",
          destination_caller_id: " imessage:+1 (555) 123-0000 ",
          is_from_me: isFromMe,
          is_group: true,
          chat_guid: conversation.chatGuid,
          is_reaction: true,
          reaction_emoji: "👍",
          reacted_to_guid: "approval-message",
        },
      }),
    ).resolves.toBe(false);
    expect(gateway.resolve).not.toHaveBeenCalled();
    await expect(
      reactions.resolveIMessageApprovalReactionTargetWithPersistence({
        ...identity,
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: identity.approvalId,
      approvalKind: "exec",
      decision: "allow-once",
    });
  },
);

it("retains explicit from-me actor approval", async () => {
  await expect(
    reactions.maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      bodyText: "",
      message: {
        sender: "+15551230000",
        destination_caller_id: "+15551230000",
        is_from_me: true,
        is_group: true,
        chat_guid: conversation.chatGuid,
        is_reaction: true,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      },
    }),
  ).resolves.toBe(true);
  expect(gateway.resolve).toHaveBeenCalledOnce();
});
