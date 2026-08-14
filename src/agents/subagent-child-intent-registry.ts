import crypto from "node:crypto";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const RESERVATION_LEASE_MS = 30_000;

export type SubagentChildIntentReservation = {
  disposition: "owner" | "duplicate";
  childIntentKey: string;
  childSessionKey: string;
  reservationRunId: string;
  reservationToken?: string;
  existingRunId?: string;
  /** Present only when a fresh host must reconcile an accepted dispatch. */
  dispatchState?: "dispatching" | "unknown";
};

type ChildIntentRegistryDependencies = {
  getRuns: () => Map<string, SubagentRunRecord>;
  countActiveRunsForSession: (sessionKey: string) => number;
  reservePersisted: (
    entry: SubagentRunRecord,
    maxActiveChildren?: number,
  ) => SubagentRunRecord | null;
  transitionPersisted: (params: {
    runId: string;
    childIntentKey: string;
    reservationOwnerToken: string;
    from: "reserved" | "dispatching" | "unknown";
    to: "dispatching" | "unknown" | "cancelled";
    providerRunId?: string;
  }) => SubagentRunRecord | null;
  removePersisted: (params: {
    runId: string;
    childIntentKey: string;
    reservationOwnerToken?: string;
    onlyExpired?: boolean;
    allowUnknown?: boolean;
  }) => boolean;
  expirePersisted: (now: number) => string[];
  persistOrThrow: () => void;
  persist: () => void;
};

export function createSubagentChildIntentRegistry(deps: ChildIntentRegistryDependencies) {
  const activeReservationTokens = new Map<string, string>();

  const findAny = (childIntentKey: string) =>
    [...deps.getRuns().values()].find((entry) => entry.childIntentKey === childIntentKey);
  const findReservation = (childIntentKey: string) => {
    const entry = findAny(childIntentKey);
    return entry?.spawnAdmission === "reserved" ||
      entry?.spawnAdmission === "dispatching" ||
      entry?.spawnAdmission === "unknown"
      ? entry
      : undefined;
  };

  const duplicate = (
    childIntentKey: string,
    entry: SubagentRunRecord,
  ): SubagentChildIntentReservation => {
    const runId = entry.providerRunId ?? entry.childIntentKey ?? entry.runId;
    const canReconcile =
      !activeReservationTokens.has(childIntentKey) &&
      (entry.spawnAdmission === "dispatching" || entry.spawnAdmission === "unknown") &&
      typeof entry.reservationOwnerToken === "string";
    const base: SubagentChildIntentReservation = {
      disposition: "duplicate",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: runId,
      existingRunId: runId,
    };
    if (canReconcile) {
      return {
        ...base,
        dispatchState: entry.spawnAdmission as "dispatching" | "unknown",
        reservationToken: entry.reservationOwnerToken,
      };
    }
    return base;
  };

  const reserve = (params: {
    childIntentKey: string;
    childSessionKey: string;
    reservationRunId: string;
    requesterSessionKey: string;
    requesterDisplayKey: string;
    task: string;
    taskName?: string;
    label?: string;
    cleanup: "delete" | "keep";
    expectsCompletionMessage?: boolean;
    spawnMode?: "run" | "session";
    maxActiveChildren?: number;
    intentBehaviorDigest?: string;
  }): SubagentChildIntentReservation => {
    const childIntentKey = params.childIntentKey.trim();
    const requesterSessionKey = params.requesterSessionKey.trim();
    if (!childIntentKey || !requesterSessionKey) {
      throw new Error("child intent admission requires a host identity");
    }
    const now = Date.now();
    const existing = findAny(childIntentKey);
    if (existing && existing.requesterSessionKey === requesterSessionKey) {
      if (existing.childIntentBehaviorDigest !== params.intentBehaviorDigest) {
        throw new Error("child intent conflicts with an existing behavior binding");
      }
      if (
        existing.spawnAdmission === "reserved" &&
        typeof existing.reservationExpiresAt === "number" &&
        existing.reservationExpiresAt <= now
      ) {
        deps.removePersisted({
          runId: existing.runId,
          childIntentKey,
          onlyExpired: true,
        });
        deps.getRuns().delete(existing.runId);
        activeReservationTokens.delete(childIntentKey);
      } else {
        return duplicate(childIntentKey, existing);
      }
    } else if (existing) {
      throw new Error("child intent is already bound to another controller");
    }

    const activeChildren = deps.countActiveRunsForSession(requesterSessionKey);
    if (
      typeof params.maxActiveChildren === "number" &&
      Number.isSafeInteger(params.maxActiveChildren) &&
      activeChildren >= params.maxActiveChildren
    ) {
      throw new Error(
        `sessions_spawn has reached max active children for this session (${activeChildren}/${params.maxActiveChildren})`,
      );
    }

    const reservationRunId = params.reservationRunId.trim();
    const reservationOwnerToken = crypto.randomUUID();
    const entry = normalizeSubagentRunState({
      runId: reservationRunId,
      childIntentKey,
      spawnAdmission: "reserved",
      childIntentBehaviorDigest: params.intentBehaviorDigest,
      reservationOwnerToken,
      reservationExpiresAt: now + RESERVATION_LEASE_MS,
      childSessionKey: params.childSessionKey.trim(),
      requesterSessionKey,
      requesterDisplayKey: params.requesterDisplayKey,
      task: params.task,
      taskName: params.taskName,
      label: params.label,
      cleanup: params.cleanup,
      expectsCompletionMessage: params.expectsCompletionMessage,
      spawnMode: params.spawnMode,
      createdAt: now,
      startedAt: now,
      execution: { status: "running", startedAt: now },
    });
    const persisted = deps.reservePersisted(entry, params.maxActiveChildren);
    if (persisted) {
      return duplicate(childIntentKey, persisted);
    }
    deps.getRuns().set(reservationRunId, entry);
    activeReservationTokens.set(childIntentKey, reservationOwnerToken);
    return {
      disposition: "owner",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId,
      reservationToken: reservationOwnerToken,
    };
  };

  const release = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    if (activeReservationTokens.get(key) !== params.reservationToken) {
      return;
    }
    const entry = findReservation(key);
    if (!entry || entry.reservationOwnerToken !== params.reservationToken) {
      activeReservationTokens.delete(key);
      return;
    }
    if (
      !deps.removePersisted({
        runId: entry.runId,
        childIntentKey: key,
        reservationOwnerToken: params.reservationToken,
      })
    ) {
      throw new Error("child intent reservation changed before release");
    }
    deps.getRuns().delete(entry.runId);
    activeReservationTokens.delete(key);
  };

  const markDispatching = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    const entry = findReservation(key);
    if (!entry || activeReservationTokens.get(key) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    const updated = deps.transitionPersisted({
      runId: entry.runId,
      childIntentKey: key,
      reservationOwnerToken: params.reservationToken,
      from: "reserved",
      to: "dispatching",
    });
    if (!updated) {
      throw new Error("child intent reservation was cancelled or expired");
    }
    Object.assign(entry, updated);
  };

  const markUnknown = (params: {
    childIntentKey: string;
    reservationToken: string;
    providerRunId?: string;
  }) => {
    const key = params.childIntentKey.trim();
    const entry = findReservation(key);
    if (!entry || activeReservationTokens.get(key) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    const updated = deps.transitionPersisted({
      runId: entry.runId,
      childIntentKey: key,
      reservationOwnerToken: params.reservationToken,
      from: entry.spawnAdmission === "dispatching" ? "dispatching" : "reserved",
      to: "unknown",
      providerRunId: params.providerRunId,
    });
    if (!updated) {
      throw new Error("child intent reservation changed before reconciliation");
    }
    Object.assign(entry, updated);
    activeReservationTokens.delete(key);
  };

  const cancel = (childIntentKey: string) => {
    const key = childIntentKey.trim();
    const entry = findReservation(key);
    if (!entry) {
      return false;
    }
    const token = entry.reservationOwnerToken;
    if (!token) {
      return false;
    }
    const updated = deps.transitionPersisted({
      runId: entry.runId,
      childIntentKey: key,
      reservationOwnerToken: token,
      from:
        entry.spawnAdmission === "dispatching"
          ? "dispatching"
          : entry.spawnAdmission === "unknown"
            ? "unknown"
            : "reserved",
      to: "cancelled",
    });
    if (!updated) {
      return false;
    }
    Object.assign(entry, updated);
    activeReservationTokens.delete(key);
    return true;
  };

  const takeForRegistration = (params: { childIntentKey?: string; reservationToken?: string }) => {
    const key = params.childIntentKey?.trim();
    if (!key) {
      return undefined;
    }
    const reservation = findReservation(key);
    if (!reservation) {
      return undefined;
    }
    if (
      !params.reservationToken ||
      activeReservationTokens.get(key) !== params.reservationToken ||
      reservation.reservationOwnerToken !== params.reservationToken
    ) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    if (
      !deps.removePersisted({
        runId: reservation.runId,
        childIntentKey: key,
        reservationOwnerToken: params.reservationToken,
        onlyExpired: false,
      })
    ) {
      throw new Error("child intent dispatch reservation changed before registration");
    }
    deps.getRuns().delete(reservation.runId);
    activeReservationTokens.delete(key);
    return { reservation, childIntentKey: key, reservationToken: params.reservationToken };
  };

  const adopt = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    const entry = findReservation(key);
    if (
      !entry ||
      (entry.spawnAdmission !== "dispatching" && entry.spawnAdmission !== "unknown") ||
      entry.reservationOwnerToken !== params.reservationToken ||
      activeReservationTokens.has(key)
    ) {
      return false;
    }
    activeReservationTokens.set(key, params.reservationToken);
    return true;
  };

  const abandonUnresolved = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    const entry = findReservation(key);
    if (
      !entry ||
      (entry.spawnAdmission !== "dispatching" && entry.spawnAdmission !== "unknown") ||
      entry.reservationOwnerToken !== params.reservationToken
    ) {
      return false;
    }
    if (
      !deps.removePersisted({
        runId: entry.runId,
        childIntentKey: key,
        reservationOwnerToken: params.reservationToken,
        allowUnknown: true,
      })
    ) {
      return false;
    }
    deps.getRuns().delete(entry.runId);
    activeReservationTokens.delete(key);
    return true;
  };

  const assertDispatchIdentityAvailable = (childIntentKey?: string, reservationToken?: string) => {
    const key = childIntentKey?.trim();
    if (!key) {
      return;
    }
    const existing = findAny(key);
    if (
      existing &&
      (existing.spawnAdmission === "dispatched" ||
        existing.spawnAdmission === "cancelled" ||
        existing.spawnAdmission === "expired" ||
        (existing.spawnAdmission === "unknown" &&
          existing.reservationOwnerToken !== reservationToken))
    ) {
      throw new Error("child intent is already dispatched or cancelled");
    }
  };

  const restoreAfterRegistrationFailure = (params: {
    reservation: SubagentRunRecord;
    childIntentKey: string;
    reservationToken: string;
  }) => {
    deps.getRuns().set(params.reservation.runId, params.reservation);
    activeReservationTokens.set(params.childIntentKey, params.reservationToken);
    deps.persistOrThrow();
  };

  const expireStale = (now = Date.now()) => {
    const expiredRunIds = new Set(deps.expirePersisted(now));
    for (const [runId, entry] of deps.getRuns()) {
      if (expiredRunIds.has(runId)) {
        deps.getRuns().delete(runId);
        if (entry.childIntentKey) {
          activeReservationTokens.delete(entry.childIntentKey);
        }
      }
    }
    return expiredRunIds.size;
  };

  return {
    reserve,
    release,
    markDispatching,
    markUnknown,
    cancel,
    adopt,
    abandonUnresolved,
    takeForRegistration,
    assertDispatchIdentityAvailable,
    restoreAfterRegistrationFailure,
    expireStale,
    reset: () => activeReservationTokens.clear(),
  };
}
