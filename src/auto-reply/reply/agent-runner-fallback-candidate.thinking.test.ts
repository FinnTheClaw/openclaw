import { describe, expect, it } from "vitest";
import { resolveFallbackCandidateThinkingLevel } from "./agent-runner-fallback-candidate.js";

const config = {
  agents: {
    defaults: {
      thinkingDefault: "high" as const,
      models: {
        "openai/gpt-5.6-terra": { params: { thinking: "high" } },
        "openai/gpt-5.6-luna": { params: { thinking: "medium" } },
        "remote-llm/moira/brain": { params: { thinking: "medium" } },
      },
    },
  },
};

describe("fallback candidate thinking defaults", () => {
  it("re-resolves automatic fallback thinking for each configured model", () => {
    expect(
      resolveFallbackCandidateThinkingLevel({
        cfg: config,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        level: "high",
      }),
    ).toBe("medium");
    expect(
      resolveFallbackCandidateThinkingLevel({
        cfg: config,
        provider: "remote-llm",
        modelId: "moira/brain",
        level: "high",
      }),
    ).toBe("medium");
  });

  it("preserves an explicit current-turn thinking override", () => {
    expect(
      resolveFallbackCandidateThinkingLevel({
        cfg: config,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        level: "high",
        thinkingLevelExplicit: true,
      }),
    ).toBe("high");
  });
});
