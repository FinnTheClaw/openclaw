import { expect, it } from "vitest";
import { mirrorMessageToolVisibleReplies } from "./chat-display-projection.message-tool.js";

const legacySend = () => [
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "message-call",
        name: "message",
        arguments: { action: "send", message: "historical delivered reply" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "message-call",
    toolName: "message",
    content: [{ type: "text", text: '{"ok":true}' }],
  },
];
const text = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const inferredMirrors = (messages: unknown[]) =>
  messages.filter(
    (message) =>
      typeof message === "object" && message !== null && "openclawMessageToolMirror" in message,
  );

it.each(["NO_REPLY", "announce_skip", " REPLY_SKIP "])(
  "projects historical successful tool sends before exact legacy control final %s",
  (control) => {
    const messages = [...legacySend(), text(control)];
    const projected = mirrorMessageToolVisibleReplies(messages);
    expect(inferredMirrors(projected)).toHaveLength(1);
    expect(inferredMirrors(projected)[0]).toMatchObject({
      content: [{ type: "text", text: "historical delivered reply" }],
      openclawMessageToolMirror: { toolCallId: "message-call" },
    });
  },
);

it("keeps producer-owned final source-reply mirrors authoritative", () => {
  const mirror = {
    ...text("native canonical reply"),
    display: true,
    openclawDeliveryMirror: {
      kind: "message-tool-source-reply",
      final: true,
      sourceTurnId: "native-turn",
      toolCallId: "message-call",
    },
  };
  const messages = [...legacySend(), mirror, text("NO_REPLY")];
  const projected = mirrorMessageToolVisibleReplies(messages);
  expect(inferredMirrors(projected)).toEqual([]);
  expect(projected).toContain(mirror);
});

it("honors explicit visible control-looking text instead of inferring another reply", () => {
  const messages = [...legacySend(), { ...text("NO_REPLY"), display: true }];
  expect(mirrorMessageToolVisibleReplies(messages)).toBe(messages);
});

it("does not treat commentary as the completion of a historical send", () => {
  const commentary = { ...text("NO_REPLY"), phase: "commentary", endTurn: false };
  const messages = [...legacySend(), commentary];
  expect(mirrorMessageToolVisibleReplies(messages)).toBe(messages);
});
