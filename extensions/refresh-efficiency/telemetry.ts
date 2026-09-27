import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type C02RunMetrics = {
  toolCallCount: number;
  modelCallCount: number;
};

type C02Usage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
};

function metricNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageMetric(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
} | undefined): C02Usage {
  return {
    input: metricNumber(usage?.input),
    output: metricNumber(usage?.output),
    cacheRead: metricNumber(usage?.cacheRead),
    cacheWrite: metricNumber(usage?.cacheWrite),
    total: metricNumber(usage?.total),
  };
}

function logMetric(api: OpenClawPluginApi, metric: Record<string, unknown>): void {
  try {
    api.logger.info(JSON.stringify(metric));
  } catch {
    // Observation must never affect the host path.
  }
}

/** Registers passive C02 execution measurements without retaining transcripts or results. */
export function registerC02Telemetry(api: OpenClawPluginApi): void {
  const runMetrics = new Map<string, C02RunMetrics>();

  const getRunMetrics = (runId: string): C02RunMetrics => {
    const existing = runMetrics.get(runId);
    if (existing) {
      return existing;
    }
    const created = { toolCallCount: 0, modelCallCount: 0 };
    runMetrics.set(runId, created);
    return created;
  };

  api.on("after_tool_call", (event, ctx) => {
    try {
      const runId = event.runId ?? ctx.runId ?? null;
      if (runId) {
        getRunMetrics(runId).toolCallCount += 1;
      }
      logMetric(api, {
        event: "c02.telemetry.tool_call",
        runId,
        sessionId: ctx.sessionId ?? null,
        sessionKey: ctx.sessionKey ?? null,
        agentId: ctx.agentId ?? null,
        toolCallId: event.toolCallId ?? ctx.toolCallId ?? null,
        toolName: event.toolName,
        durationMs: metricNumber(event.durationMs),
        outcome: event.error === undefined ? "completed" : "error",
      });
    } catch {
      // Observation must never affect the host path.
    }
    return undefined;
  });

  api.on("model_call_ended", (event, ctx) => {
    try {
      getRunMetrics(event.runId).modelCallCount += 1;
      logMetric(api, {
        event: "c02.telemetry.model_call",
        runId: event.runId,
        sessionId: event.sessionId ?? ctx.sessionId ?? null,
        sessionKey: event.sessionKey ?? ctx.sessionKey ?? null,
        agentId: ctx.agentId ?? null,
        callId: event.callId,
        provider: event.provider,
        model: event.model,
        durationMs: metricNumber(event.durationMs),
        outcome: event.outcome,
        errorCategory: event.errorCategory ?? null,
      });
    } catch {
      // Observation must never affect the host path.
    }
    return undefined;
  });

  api.on("llm_output", (event, ctx) => {
    try {
      // Native llm_output can follow agent_end; keep usage independent of run counters.
      logMetric(api, {
        event: "c02.telemetry.llm_output",
        runId: event.runId,
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey ?? null,
        agentId: ctx.agentId ?? null,
        provider: event.provider,
        model: event.model,
        resolvedRef: event.resolvedRef ?? null,
        usage: usageMetric(event.usage),
      });
    } catch {
      // Observation must never affect the host path.
    }
    return undefined;
  });

  api.on("agent_end", (event, ctx) => {
    try {
      const runId = event.runId ?? ctx.runId ?? null;
      const counts = runId ? runMetrics.get(runId) : undefined;
      if (runId) {
        runMetrics.delete(runId);
      }
      logMetric(api, {
        event: "c02.telemetry.run_complete",
        runId,
        sessionId: ctx.sessionId ?? null,
        sessionKey: ctx.sessionKey ?? null,
        agentId: ctx.agentId ?? null,
        durationMs: metricNumber(event.durationMs),
        outcome: event.success ? "completed" : "error",
        toolCallCount: counts?.toolCallCount ?? (runId ? 0 : null),
        modelCallCount: counts?.modelCallCount ?? (runId ? 0 : null),
      });
    } catch {
      // Observation must never affect the host path.
    }
    return undefined;
  });
}
