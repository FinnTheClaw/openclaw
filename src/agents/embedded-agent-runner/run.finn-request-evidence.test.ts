import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedCompactDirect,
  mockedPickFallbackThinkingLevel,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("terminal Finn request evidence", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("preserves collected evidence when retries terminate in an error result", async () => {
    mockedPickFallbackThinkingLevel.mockReturnValue("low");
    mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
      const attemptParams = params as EmbeddedRunAttemptParams;
      if (attemptParams.finnRequestEvidence?.requestIds.length === 0) {
        attemptParams.finnRequestEvidence.requestIds.push("req_retry-terminal-1");
      }
      return makeAttemptResult({ promptError: new Error("unsupported reasoning mode") });
    });

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.agentMeta?.finnRequestIds).toEqual(["req_retry-terminal-1"]);
    expect(result.meta.agentMeta?.finnRequestIdEvidenceComplete).toBe(true);
  });
});
