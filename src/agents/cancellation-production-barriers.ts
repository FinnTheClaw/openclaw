/** Exact-run observation holds for the delivery cancellation campaign only. */
import {
  emitAgentEvent,
  registerAgentEventLifecycleRotationHandler,
} from "../infra/agent-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
export type CancellationBarrierPhase =
  | "accepted_before_provider"
  | "subagents_list_committed"
  | "child_started_before_provider";
export type CancellationBarrierRequest = {
  phase: CancellationBarrierPhase;
  armExpiresInMs: number;
  holdExpiresInMs: number;
};
type Observation = Record<string, string | number | boolean>;
type ReleaseReason =
  | "arm_expired_before_boundary"
  | "insufficient_run_lifetime"
  | "hold_expired"
  | "native_abort"
  | "lifecycle_rotation";
type Entry = {
  runId: string;
  sessionKey: string;
  agentId: string;
  lifecycleGeneration: string;
  ownerConnId: string;
  ownerDeviceId?: string;
  phase: CancellationBarrierPhase;
  armedAt: number;
  armExpiresAt: number;
  runExpiresAt: number;
  holdExpiresInMs: number;
  holdExpiresAt?: number;
  state: "armed" | "held";
  observation?: Observation;
  observedToolCallId?: string;
  released: Promise<ReleaseReason>;
  resolve: (reason: ReleaseReason) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};
type State = { entries: Map<string, Entry> };
const KEY = Symbol.for("openclaw.cancellationProductionBarriers.state");
const PROTOCOL = "openclaw.cancellation-barrier.v1";
const CAMPAIGN_SESSION = /^agent:finn:campaign-delivery-[0-9a-f]{32}$/;
const CAMPAIGN_RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const getState = () => resolveGlobalSingleton<State>(KEY, () => ({ entries: new Map() }));
function receipt(
  e: Entry,
  state: "armed" | "held" | "released" | "child_abort_not_observed",
  extra: Record<string, unknown> = {},
) {
  emitAgentEvent({
    runId: e.runId,
    sessionKey: e.sessionKey,
    agentId: e.agentId,
    lifecycleGeneration: e.lifecycleGeneration,
    stream: "cancellation_barrier",
    data: {
      protocol: PROTOCOL,
      barrierId: `${e.runId}:${e.phase}`,
      phase: e.phase,
      state,
      armedAt: e.armedAt,
      armExpiresAt: e.armExpiresAt,
      runExpiresAt: e.runExpiresAt,
      ...(e.holdExpiresAt ? { holdExpiresAt: e.holdExpiresAt } : {}),
      ...(e.observation ? { observation: e.observation } : {}),
      ...extra,
    },
  });
}
function release(e: Entry, reason: ReleaseReason) {
  if (getState().entries.get(e.runId) !== e) return;
  getState().entries.delete(e.runId);
  clearTimeout(e.timer);
  e.signal.removeEventListener("abort", e.onAbort);
  try {
    receipt(e, "released", { releasedAt: Date.now(), releaseReason: reason });
  } finally {
    e.resolve(reason);
  }
}
export function armCancellationProductionBarrier(args: {
  request?: CancellationBarrierRequest;
  runId: string;
  sessionKey?: string;
  agentId: string;
  lifecycleGeneration: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  abortSignal: AbortSignal;
  runExpiresAtMs?: number;
  modelRun: boolean;
  suppressVisibleSessionEffects: boolean;
}) {
  const r = args.request;
  if (!r) return;
  if (
    args.agentId !== "finn" ||
    !args.sessionKey ||
    !CAMPAIGN_SESSION.test(args.sessionKey) ||
    !CAMPAIGN_RUN.test(args.runId) ||
    !args.ownerConnId ||
    args.modelRun ||
    args.suppressVisibleSessionEffects
  )
    throw new Error("cancellationBarrier is restricted to an owned delivery campaign run");
  if (!Number.isInteger(r.armExpiresInMs) || r.armExpiresInMs < 1000 || r.armExpiresInMs > 600000)
    throw new Error("cancellationBarrier armExpiresInMs must be between 1000 and 600000");
  if (!Number.isInteger(r.holdExpiresInMs) || r.holdExpiresInMs < 1000 || r.holdExpiresInMs > 30000)
    throw new Error("cancellationBarrier holdExpiresInMs must be between 1000 and 30000");
  const armedAt = Date.now();
  if (!args.runExpiresAtMs || armedAt + r.armExpiresInMs > args.runExpiresAtMs)
    throw new Error("cancellationBarrier arm lifetime must fit within the native run timeout");
  if (getState().entries.has(args.runId))
    throw new Error(`barrier already armed for ${args.runId}`);
  let resolve!: (reason: ReleaseReason) => void;
  const released = new Promise<ReleaseReason>((done) => {
    resolve = done;
  });
  const e = {} as Entry;
  Object.assign(e, {
    runId: args.runId,
    sessionKey: args.sessionKey,
    agentId: args.agentId,
    lifecycleGeneration: args.lifecycleGeneration,
    ownerConnId: args.ownerConnId,
    ...(args.ownerDeviceId ? { ownerDeviceId: args.ownerDeviceId } : {}),
    phase: r.phase,
    armedAt,
    armExpiresAt: armedAt + r.armExpiresInMs,
    runExpiresAt: args.runExpiresAtMs,
    holdExpiresInMs: r.holdExpiresInMs,
    state: "armed" as const,
    released,
    resolve,
    signal: args.abortSignal,
    onAbort: () => release(e, "native_abort"),
    timer: setTimeout(() => release(e, "arm_expired_before_boundary"), r.armExpiresInMs),
  });
  e.timer.unref?.();
  getState().entries.set(e.runId, e);
  e.signal.addEventListener("abort", e.onAbort, { once: true });
  if (e.signal.aborted) {
    release(e, "native_abort");
    return;
  }
  receipt(e, "armed");
}
async function hold(e: Entry, observation: Observation): Promise<ReleaseReason | undefined> {
  if (getState().entries.get(e.runId) !== e || e.state !== "armed") return;
  const heldAt = Date.now();
  e.observation = Object.freeze({ ...observation });
  if (heldAt + e.holdExpiresInMs > e.runExpiresAt) {
    release(e, "insufficient_run_lifetime");
    return await e.released;
  }
  clearTimeout(e.timer);
  e.state = "held";
  e.holdExpiresAt = heldAt + e.holdExpiresInMs;
  e.timer = setTimeout(() => release(e, "hold_expired"), e.holdExpiresInMs);
  e.timer.unref?.();
  receipt(e, "held", { heldAt });
  return await e.released;
}
async function observeChildAbort(signal: AbortSignal, deadline: number): Promise<boolean> {
  if (signal.aborted) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (observed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(observed);
    };
    const onAbort = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
export async function holdAcceptedRunBeforeProvider(runId: string) {
  const e = getState().entries.get(runId);
  if (e?.phase === "accepted_before_provider")
    await hold(e, { boundary: "accepted_dispatch", runId });
}
export function observeCancellationBarrierToolResult(a: {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  isError: boolean;
}) {
  const e = getState().entries.get(a.runId);
  if (
    e?.phase === "subagents_list_committed" &&
    e.state === "armed" &&
    !a.isError &&
    a.toolName === "subagents" &&
    a.toolArgs.action === "list" &&
    !e.observedToolCallId
  )
    e.observedToolCallId = a.toolCallId;
}
export async function holdCommittedSubagentsList(a: {
  runId: string;
  toolResults: readonly {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  }[];
}) {
  const e = getState().entries.get(a.runId);
  if (!e || e.phase !== "subagents_list_committed" || !e.observedToolCallId) return;
  if (
    a.toolResults.some(
      (r) =>
        r.role === "toolResult" &&
        r.toolCallId === e.observedToolCallId &&
        r.toolName === "subagents" &&
        r.isError === false,
    )
  )
    await hold(e, {
      boundary: "prepare_next_turn",
      action: "list",
      committed: true,
      toolCallId: e.observedToolCallId,
    });
}
export function hasPendingChildStartBarrier() {
  return [...getState().entries.values()].some(
    (e) => e.phase === "child_started_before_provider" && e.state === "armed",
  );
}
export async function holdChildStartBeforeProvider(a: {
  requesterRunId?: string;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  childRunId: string;
  childSessionKey?: string;
  childAbortSignal: AbortSignal;
}) {
  if (!a.requesterRunId) return;
  const e = getState().entries.get(a.requesterRunId);
  if (
    !e ||
    e.phase !== "child_started_before_provider" ||
    e.sessionKey !== a.requesterSessionKey ||
    a.requesterAgentId !== "finn"
  )
    return;
  const reason = await hold(e, {
    boundary: "child_lifecycle_start",
    requesterRunId: a.requesterRunId,
    childRunId: a.childRunId,
    ...(a.childSessionKey ? { childSessionKey: a.childSessionKey } : {}),
  });
  if (
    reason === "native_abort" &&
    !(await observeChildAbort(a.childAbortSignal, e.holdExpiresAt ?? Date.now()))
  )
    receipt(e, "child_abort_not_observed", {
      classification: "NOT_EXERCISED",
      observedAt: Date.now(),
      childRunId: a.childRunId,
      ...(a.childSessionKey ? { childSessionKey: a.childSessionKey } : {}),
    });
}
registerAgentEventLifecycleRotationHandler("cancellation-production-barriers", () => {
  for (const e of [...getState().entries.values()]) release(e, "lifecycle_rotation");
});
