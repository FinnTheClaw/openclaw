import { describe, expect, it } from "vitest";
import {
  createGovernorMemoryRetirementDecision,
  verifyGovernorMemoryRetirementDecision,
} from "./memory-governor-capability.js";

describe("governor memory retirement capability", () => {
  it.each(["expiry", "explicit_forget"] as const)(
    "authenticates the closed %s retirement reason",
    (reason) => {
      const key = "retirement-reason-fixture-key";
      const decision = createGovernorMemoryRetirementDecision(
        {
          scopeKey: "scope-a",
          factKey: "fact-a",
          staleMemoryId: "memory-a",
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 120,
          issuedAt: 130,
          reason,
          priorAuthorityBindingDigest: "a".repeat(64),
        },
        key,
      );
      expect(verifyGovernorMemoryRetirementDecision(decision, key)).toBe(true);
      expect(
        verifyGovernorMemoryRetirementDecision(
          { ...decision, semanticCutoff: decision.semanticCutoff + 1 },
          key,
        ),
      ).toBe(false);
    },
  );

  it("rejects reasons outside the closed retirement domain", () => {
    expect(() =>
      createGovernorMemoryRetirementDecision(
        {
          scopeKey: "scope-a",
          factKey: "fact-a",
          staleMemoryId: "memory-a",
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 120,
          issuedAt: 130,
          reason: "contradiction" as never,
          priorAuthorityBindingDigest: "a".repeat(64),
        },
        "retirement-reason-fixture-key",
      ),
    ).toThrow("GOVERNOR_MEMORY_RETIREMENT_DECISION_INVALID");
  });
});
