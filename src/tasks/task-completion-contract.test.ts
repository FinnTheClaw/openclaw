import { describe, expect, it } from "vitest";
import {
  isRequiredCompletionPresentationBlocked,
  resolveRequiredCompletionDeliveryFailureTerminalResult,
} from "./task-completion-contract.js";

describe("required completion presentation", () => {
  it("blocks successful execution that ends with progress-only text", () => {
    expect(
      isRequiredCompletionPresentationBlocked({
        required: true,
        executionSucceeded: true,
        resultText: "I will now inspect the remaining evidence.",
      }),
    ).toBe(true);
  });

  it("does not block a final deliverable or a failed execution", () => {
    expect(
      isRequiredCompletionPresentationBlocked({
        required: true,
        executionSucceeded: true,
        resultText: "The requested report is complete.",
      }),
    ).toBe(false);
    expect(
      isRequiredCompletionPresentationBlocked({
        required: true,
        executionSucceeded: false,
        resultText: null,
      }),
    ).toBe(false);
  });
});

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });
});
