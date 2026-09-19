import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

describe("schema-gated stringified tool arguments preserve integer identity", () => {
  it.each([
    {
      type: "object",
      schema: { type: "object", properties: { target: { type: "string" } } },
      input: '{"target":9223372036854775807}',
      expected: { target: "9223372036854775807" },
    },
    {
      type: "array",
      schema: { type: "array", items: { type: "string" } },
      input: "[9223372036854775807]",
      expected: ["9223372036854775807"],
    },
  ])("preserves IDs in a stringified $type", ({ schema, input, expected }) => {
    const tool = {
      name: "lookup",
      description: "test",
      parameters: { type: "object", properties: { payload: schema }, required: ["payload"] },
    } as Tool;
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call_test",
        name: "lookup",
        arguments: { payload: input },
      }),
    ).toEqual({ payload: expected });
  });
});
