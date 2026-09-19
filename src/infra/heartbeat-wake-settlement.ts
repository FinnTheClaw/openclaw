import type { HeartbeatRunResult, HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

export type HeartbeatWakeSettlement = {
  active: boolean;
  settle: (result: HeartbeatRunResult) => void;
};

export function activeHeartbeatWakeSettlements(
  ...groups: Array<readonly HeartbeatWakeSettlement[] | undefined>
): HeartbeatWakeSettlement[] {
  return groups.flatMap((group) => group ?? []).filter((settlement) => settlement.active);
}

export function settleHeartbeatWakeSettlements(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
  result: HeartbeatRunResult,
) {
  for (const settlement of settlements ?? []) {
    settlement.settle(result);
  }
}

/** A broadcast caller completes only after every original target has a terminal outcome. */
export function splitHeartbeatWakeSettlements(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
  targetCount: number,
): HeartbeatWakeSettlement[][] {
  const parents = activeHeartbeatWakeSettlements(settlements);
  const results: Array<HeartbeatRunResult | undefined> = Array.from({ length: targetCount });
  let remaining = targetCount;
  return Array.from({ length: targetCount }, (_, index) => {
    if (parents.length === 0) {
      return [];
    }
    const child: HeartbeatWakeSettlement = {
      active: true,
      settle: (result) => {
        if (!child.active) {
          return;
        }
        child.active = false;
        results[index] = result;
        remaining--;
        if (remaining !== 0) {
          return;
        }
        const ran = results.filter(
          (outcome): outcome is Extract<HeartbeatRunResult, { status: "ran" }> =>
            outcome?.status === "ran",
        );
        settleHeartbeatWakeSettlements(
          parents,
          ran.length > 0
            ? { status: "ran", durationMs: Math.max(...ran.map((outcome) => outcome.durationMs)) }
            : (results[0] ?? { status: "skipped", reason: "disabled" }),
        );
      },
    };
    return [child];
  });
}

/** Expands retained broadcast work without changing queue or retry ownership. */
export function resolveHeartbeatWakeSettlementOutcomes<
  Wake extends HeartbeatWakeRequest & { settlements?: HeartbeatWakeSettlement[] },
>(
  pendingWake: Wake,
  result: HeartbeatRunResult,
  isRetryableSkipReason: (reason: string) => boolean,
  retryableGuardSkipReasons: ReadonlySet<string>,
): Array<{
  wake: Wake;
  result: HeartbeatRunResult;
  busy: boolean;
  guard: number | boolean | undefined;
}> {
  const retainsGuardWork =
    pendingWake.tasks?.length ||
    pendingWake.intent === "task" ||
    pendingWake.intent === "event" ||
    pendingWake.intent === "immediate";
  const broadcast = result.broadcastResults?.some(
    ({ result: outcome }) =>
      outcome.status === "skipped" &&
      (isRetryableSkipReason(outcome.reason) ||
        (retryableGuardSkipReasons.has(outcome.reason) && retainsGuardWork)),
  )
    ? result.broadcastResults
    : undefined;
  const childSettlements = broadcast
    ? splitHeartbeatWakeSettlements(pendingWake.settlements, broadcast.length)
    : undefined;
  const outcomes = broadcast
    ? broadcast.map(({ agentId, result: agentResult }, index) => ({
        wake: {
          ...pendingWake,
          agentId,
          // Broadcast dispatch uses each enrolled destination, not a targeted override.
          heartbeat: undefined,
          settlements: childSettlements?.[index],
        },
        result: agentResult,
      }))
    : [{ wake: pendingWake, result }];
  return outcomes.map((outcome) => ({
    wake: outcome.wake,
    result: outcome.result,
    busy: outcome.result.status === "skipped" && isRetryableSkipReason(outcome.result.reason),
    guard:
      outcome.result.status === "skipped" &&
      retryableGuardSkipReasons.has(outcome.result.reason) &&
      retainsGuardWork,
  }));
}

function createHeartbeatWakeSettlement(abortSignal?: AbortSignal): {
  result: Promise<HeartbeatRunResult>;
  settlement: HeartbeatWakeSettlement;
} {
  const control: {
    resolve?: (result: HeartbeatRunResult) => void;
    removeAbortListener?: () => void;
  } = {};
  const result = new Promise<HeartbeatRunResult>((resolve) => {
    control.resolve = resolve;
  });
  const settlement: HeartbeatWakeSettlement = {
    active: true,
    settle: (outcome) => {
      if (!settlement.active) {
        return;
      }
      settlement.active = false;
      control.removeAbortListener?.();
      control.resolve?.(outcome);
    },
  };
  const onAbort = () => settlement.settle({ status: "failed", reason: "heartbeat wake cancelled" });
  control.removeAbortListener = () => abortSignal?.removeEventListener("abort", onAbort);
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return { result, settlement };
}

export function createRequestHeartbeatAndWait<Request>(
  enqueue: (request: Request, settlements?: HeartbeatWakeSettlement[]) => void,
) {
  return (request: Request, lifecycle?: { abortSignal?: AbortSignal }) => {
    const pending = createHeartbeatWakeSettlement(lifecycle?.abortSignal);
    if (pending.settlement.active) {
      enqueue(request, [pending.settlement]);
    }
    return pending.result;
  };
}
