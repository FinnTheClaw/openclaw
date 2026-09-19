import { describe, expect, it } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";
import {
  createPromotedPlainTextToolCallBlock,
  projectStandalonePlainTextToolCallMessage,
} from "./promote.js";

describe("repaired tool-call integer identity", () => {
  const raw =
    '[tool:lookup]{"target":9223372036854775807,"nested":{"negative":-9223372036854775807},"safe":42}';
  const expected = {
    target: "9223372036854775807",
    nested: { negative: "-9223372036854775807" },
    safe: 42,
  };
  it("preserves integer identifiers before executable promotion", () => {
    expect(parseStandalonePlainTextToolCallBlocks(raw)?.[0]?.arguments).toEqual(expected);
  });
  it("preserves integer identifiers in promoted arguments and serialized deltas", () => {
    const projected = projectStandalonePlainTextToolCallMessage({
      allowedToolNames: new Set(["lookup"]),
      createToolCallBlock: createPromotedPlainTextToolCallBlock,
      message: { role: "assistant", content: [{ type: "text", text: raw }], stopReason: "stop" },
      requireAssistantRole: true,
    });
    expect(projected?.message.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "lookup",
        arguments: expected,
        partialArgs: JSON.stringify(expected),
      }),
    ]);
  });
});
