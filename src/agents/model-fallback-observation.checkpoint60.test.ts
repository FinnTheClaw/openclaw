import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelFallbackDecisionParams } from "./model-fallback-observation.js";
import type { FallbackAttempt } from "./model-fallback.types.js";

const logger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    child: () => ({ isEnabled: () => true, warn: logger.warn }),
  }),
}));

import { logModelFallbackDecision } from "./model-fallback-observation.js";

const priorCandidate = { provider: "primary", model: "model-a" } as const;
const fallbackCandidate = {
  provider: "secondary",
  model: "model-b",
  routeOrigin: "configured-fallback",
  routeResolution: "resolved",
} as const;

const cases = [
  {
    id: "CP60-FB01",
    error: "HTTP 401 api_key=synthetic-redaction-01",
    forbidden: "synthetic-redaction-01",
  },
  {
    id: "CP60-FB02",
    error: "HTTP 401 API-key: synthetic-redaction-02",
    forbidden: "synthetic-redaction-02",
  },
  {
    id: "CP60-FB03",
    error: "HTTP 401 Bearer synthetic-redaction-03",
    forbidden: "synthetic-redaction-03",
  },
  {
    id: "CP60-FB04",
    error: 'HTTP 401 {"api_key":"synthetic-redaction-04"}',
    forbidden: "synthetic-redaction-04",
  },
  {
    id: "CP60-FB05",
    error: "HTTP 401 Cookie: sid=synthetic-redaction-05",
    forbidden: "synthetic-redaction-05",
  },
  {
    id: "CP60-FB06",
    error: `upstream ${"x".repeat(800)} api_key=synthetic-redaction-06`,
    forbidden: "synthetic-redaction-06",
  },
  {
    id: "CP60-FB07",
    error: "HTTP 429 ordinary rate limit; retry later",
  },
  {
    id: "CP60-FB08",
    error: "ordinary connection reset while reading response",
  },
  {
    id: "CP60-FB09",
    error: "",
  },
  {
    id: "CP60-FB10",
    error: undefined,
  },
] as const;

function payload(): Record<string, unknown> {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  return logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
}

function makeParams(id: string, previousAttempts?: FallbackAttempt[]): ModelFallbackDecisionParams {
  return {
    decision: "candidate_succeeded",
    runId: `run-${id}`,
    sessionId: `session-${id}`,
    lane: "default",
    requestedProvider: priorCandidate.provider,
    requestedModel: priorCandidate.model,
    candidate: fallbackCandidate,
    attempt: 2,
    total: 2,
    reason: null,
    isPrimary: false,
    requestedModelMatched: false,
    fallbackConfigured: true,
    previousAttempts,
  };
}

beforeEach(() => logger.warn.mockClear());

describe("checkpoint 60 fallback success observation", () => {
  it.each(cases)("$id projects prior error without leaking it", ({ id, error, ...testCase }) => {
    const status = error?.startsWith("HTTP 429")
      ? 429
      : error?.startsWith("HTTP 401")
        ? 401
        : undefined;
    const previousAttempts: FallbackAttempt[] | undefined =
      error === undefined
        ? undefined
        : [{ ...priorCandidate, reason: "unknown", ...(status ? { status } : {}), error }];
    let expectedDetail: string | undefined;
    if (previousAttempts) {
      const failureStep = logModelFallbackDecision({
        ...makeParams(id),
        decision: "candidate_failed",
        candidate: priorCandidate,
        attempt: 1,
        reason: "unknown",
        error,
        nextCandidate: fallbackCandidate,
      });
      expectedDetail = failureStep?.fallbackStepFromFailureDetail;
      logger.warn.mockClear();
    }

    const step = logModelFallbackDecision(makeParams(id, previousAttempts));
    const logged = payload();
    expect(logged).toMatchObject({
      event: "model_fallback_decision",
      decision: "candidate_succeeded",
      requestedProvider: priorCandidate.provider,
      requestedModel: priorCandidate.model,
      candidateProvider: fallbackCandidate.provider,
      candidateModel: fallbackCandidate.model,
      candidateRouteOrigin: "configured-fallback",
      candidateRouteResolution: "resolved",
      attempt: 2,
      total: 2,
      fallbackConfigured: true,
      isPrimary: false,
      requestedModelMatched: false,
    });
    if (!previousAttempts) {
      expect(step).toBeUndefined();
      expect(logged).not.toHaveProperty("fallbackStepFromFailureDetail");
      return;
    }
    expect(step).toMatchObject({
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "primary/model-a",
      fallbackStepToModel: "secondary/model-b",
      fallbackStepFromFailureReason: "unknown",
      fallbackStepChainPosition: 2,
      fallbackStepFinalOutcome: "succeeded",
    });
    expect(step?.fallbackStepFromFailureDetail).toBe(expectedDetail);
    expect(logged.fallbackStepFromFailureDetail).toBe(expectedDetail);
    expect(logged.previousAttempts).toEqual([
      expect.objectContaining({
        provider: priorCandidate.provider,
        model: priorCandidate.model,
        reason: "unknown",
      }),
    ]);
    if (error) {
      expect(expectedDetail).toBeTruthy();
      expect(String(expectedDetail).length).toBeLessThanOrEqual(401);
    } else {
      expect(step).not.toHaveProperty("fallbackStepFromFailureDetail");
      expect(logged).not.toHaveProperty("fallbackStepFromFailureDetail");
    }
    if ("forbidden" in testCase) {
      expect(JSON.stringify(step)).not.toContain(testCase.forbidden);
      expect(JSON.stringify(logged)).not.toContain(testCase.forbidden);
    }
  });
});
