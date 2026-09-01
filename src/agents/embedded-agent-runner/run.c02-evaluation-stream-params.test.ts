import { describe, expect, it } from "vitest";
import { resolveC02EvaluationStreamParams } from "./run.js";

describe("resolveC02EvaluationStreamParams", () => {
  it("caps only runnable C02 evaluation sessions", () => {
    expect(
      resolveC02EvaluationStreamParams("c02-eval-C02-A-001-0123456789abcdef01234567", undefined),
    ).toEqual({
      maxTokens: 512,
    });
    expect(resolveC02EvaluationStreamParams("ordinary-session", { maxTokens: 2048 })).toEqual({
      maxTokens: 2048,
    });
    expect(
      resolveC02EvaluationStreamParams("c02-eval-C02-A-001-0123456789abcdef01234567", {
        maxTokens: 2048,
      }),
    ).toEqual({
      maxTokens: 512,
    });
    expect(
      resolveC02EvaluationStreamParams("c02-eval-C02-A-001-0123456789abcdef01234567", {
        maxTokens: 128,
      }),
    ).toEqual({
      maxTokens: 128,
    });
  });
});
