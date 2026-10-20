import { describe, expect, it } from "vitest";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
describe("embedding budget fault recovery", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "keeps an invalid declared budget from disabling safe splitting: %s",
    (maxInputTokens) => {
      expect(resolveEmbeddingMaxInputTokens({ id: "openai-compatible", maxInputTokens })).toBe(
        8192,
      );
    },
  );
  it("honors the full declared destination budget", () => {
    expect(resolveEmbeddingMaxInputTokens({ id: "openai-compatible", maxInputTokens: 32768 })).toBe(
      32768,
    );
  });
});
