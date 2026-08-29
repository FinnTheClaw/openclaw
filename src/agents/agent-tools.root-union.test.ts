import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { describe, expect, it } from "vitest";

function rootUnionSchema(unionKey: "anyOf" | "oneOf"): Record<string, unknown> {
  return {
    type: "object",
    title: "MessagesReplyInput",
    additionalProperties: false,
    required: ["thread_id"],
    properties: {
      thread_id: { type: "string", minLength: 1, maxLength: 128 },
      body: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      body_file: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      task_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      turn_grant_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
    },
    [unionKey]: [
      { required: ["body"], properties: { body: { type: "string" } } },
      { required: ["body_file"], properties: { body_file: { type: "string" } } },
    ],
  };
}

describe("normalizeToolParameterSchema root unions", () => {
  it.each(["anyOf", "oneOf"] as const)(
    "preserves root properties and constraints when flattening root-level %s (#128743)",
    (unionKey) => {
      const normalized = normalizeToolParameterSchema(rootUnionSchema(unionKey)) as Record<
        string,
        unknown
      >;
      const properties = (normalized.properties as Record<string, unknown>) ?? {};
      const required = (normalized.required as string[] | undefined) ?? [];

      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining(["thread_id", "body", "body_file", "task_id", "turn_grant_id"]),
      );
      expect(normalized.additionalProperties).toBe(false);
      for (const field of required) {
        expect(Object.hasOwn(properties, field)).toBe(true);
      }
      expect(properties.thread_id).toEqual({ type: "string", minLength: 1, maxLength: 128 });
      expect(properties.body).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        default: null,
      });
      expect(properties.body_file).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        default: null,
      });
    },
  );
});
