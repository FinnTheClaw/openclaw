import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { wrapFinnRequestIdEvidenceWithCollector } from "../finn-request-id-evidence.js";
import { markBuiltInProviderTransport } from "../finn-request-id-transport.js";
import type { StreamFn } from "../runtime/index.js";
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
const coordinatorModel = {
  provider: "remote-llm",
  id: "moira/brain",
  baseUrl: "http://127.0.0.1:8300/v1",
} as Parameters<StreamFn>[0];

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
      if ((attemptParams.finnRequestEvidence?.snapshot().requestIds.length ?? 2) < 2) {
        const requestId =
          "req_retry-terminal-" +
          (attemptParams.finnRequestEvidence!.snapshot().requestIds.length + 1);
        const sentinel = new Error("provider stream sentinel");
        const providerStream: StreamFn = async (_model, _context, options) => {
          await options?.onResponse?.(
            { status: 200, headers: { "x-finn-request-id": requestId } },
            {} as never,
          );
          return {
            async *[Symbol.asyncIterator]() {},
            async result() {
              throw sentinel;
            },
          } as never;
        };
        markBuiltInProviderTransport(providerStream);
        const wrapped = await wrapFinnRequestIdEvidenceWithCollector(
          providerStream,
          attemptParams.finnRequestEvidence!,
          { selectedStreamFn: providerStream, resolvedModel: coordinatorModel },
        )(coordinatorModel, {} as never, {} as never);
        await expect(wrapped.result()).rejects.toBe(sentinel);
      }
      return makeAttemptResult({ promptError: new Error("unsupported reasoning mode") });
    });

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.agentMeta?.finnRequestIds).toEqual([
      "req_retry-terminal-1",
      "req_retry-terminal-2",
    ]);
    expect(result.meta.agentMeta?.finnRequestIdEvidenceComplete).toBe(false);
  });
});
