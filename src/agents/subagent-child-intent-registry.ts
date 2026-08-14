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
  dispatchState?: "dispatching" | "unknown";
  durableReceiptRequired?: boolean;
};

type ChildIntentRegistryDependencies = {
  getRuns: () => Map<string, SubagentRunRecord>;
  reservePersisted: (
    entry: SubagentRunRecord,
    maxActiveChildren?: number,
  ) => SubagentRunRecord | null;
  findPersisted: (childIntentKey: string) => SubagentRunRecord | undefined;
  transitionPersisted: (params: {
    childIntentKey: string;
    reservationOwnerToken: string;
    from: "reserved" | "dispatching" | "unknown";
    to: "dispatching" | "unknown" | "cancelled";
    providerRunId?: string;
    gatewayReceiptId?: string;
  }) => SubagentRunRecord | null;
  claimPersisted: (params: {
    childIntentKey: string;
    reservationOwnerToken: string;
  }) => string | false;
  cancelPersisted: (childIntentKey: string) => boolean;
  removePersisted: (params: {
    childIntentKey: string;
    reservationOwnerToken?: string;
    onlyExpired?: boolean;
    allowUnknown?: boolean;
  }) => boolean;
  expirePersisted: (now: number) => string[];
};

export function createSubagentChildIntentRegistry(deps: ChildIntentRegistryDependencies) {
  const activeReservationTokens = new Map<string, string>();
  const find = (key: string) => deps.findPersisted(key.trim());

  const duplicate = (
    childIntentKey: string,
    entry: SubagentRunRecord,
  ): SubagentChildIntentReservation => {
    const existingRunId = entry.providerRunId ?? entry.runId;
    const canReconcile =
      (entry.spawnAdmission === "dispatching" || entry.spawnAdmission === "unknown") &&
      typeof entry.reservationOwnerToken === "string" &&
      !activeReservationTokens.has(childIntentKey);
    return {
      disposition: "duplicate",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: childIntentKey,
      existingRunId,
      ...(entry.childIntentKey ? { durableReceiptRequired: true } : {}),
      ...(canReconcile
        ? {
            dispatchState: entry.spawnAdmission as "dispatching" | "unknown",
            reservationToken: entry.reservationOwnerToken,
          }
        : {}),
    };
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
    intentRequestDigest?: string;
    targetAgentId?: string;
    operationKey?: string;
  }): SubagentChildIntentReservation => {
    const childIntentKey = params.childIntentKey.trim();
    const requesterSessionKey = params.requesterSessionKey.trim();
    if (!childIntentKey || !requesterSessionKey) {
      throw new Error("child intent admission requires a host identity");
    }
    const now = Date.now();
    const reservationOwnerToken = crypto.randomUUID();
    const entry = normalizeSubagentRunState({
      runId: params.reservationRunId.trim(),
      childIntentKey,
      childIntentLookupKey: childIntentKey,
      childIntentRequestDigest: params.intentRequestDigest ?? childIntentKey,
      childIntentOperationKey: params.operationKey,
      childIntentTargetAgentId: params.targetAgentId,
      spawnAdmission: "reserved",
      childIntentBehaviorDigest: params.intentBehaviorDigest ?? childIntentKey,
      reservationOwnerToken,
      reservationExpiresAt: now + RESERVATION_LEASE_MS,
      childSessionKey: params.childSessionKey.trim(),
      controllerSessionKey: requesterSessionKey,
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
      if (persisted.requesterSessionKey !== requesterSessionKey) {
        throw new Error("child intent is already bound to another controller");
      }
      return duplicate(childIntentKey, persisted);
    }
    activeReservationTokens.set(childIntentKey, reservationOwnerToken);
    return {
      disposition: "owner",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: entry.runId,
      reservationToken: reservationOwnerToken,
    };
  };

  const release = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    if (activeReservationTokens.get(key) !== params.reservationToken) {
      return;
    }
    if (
      !deps.removePersisted({ childIntentKey: key, reservationOwnerToken: params.reservationToken })
    ) {
      throw new Error("child intent reservation changed before release");
    }
    activeReservationTokens.delete(key);
  };

  const markDispatching = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    if (activeReservationTokens.get(key) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    if (
      !deps.transitionPersisted({
        childIntentKey: key,
        reservationOwnerToken: params.reservationToken,
        from: "reserved",
        to: "dispatching",
      })
    ) {
      throw new Error("child intent reservation was cancelled or expired");
    }
  };

  const markUnknown = (params: {
    childIntentKey: string;
    reservationToken: string;
    providerRunId?: string;
    retainOwnership?: boolean;
  }) => {
    const key = params.childIntentKey.trim();
    if (activeReservationTokens.get(key) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    const entry = find(key);
    if (
      !entry ||
      !deps.transitionPersisted({
        childIntentKey: key,
        reservationOwnerToken: params.reservationToken,
        from: entry.spawnAdmission === "dispatching" ? "dispatching" : "reserved",
        to: "unknown",
        providerRunId: params.providerRunId,
        gatewayReceiptId: params.childIntentKey,
      })
    ) {
      throw new Error("child intent reservation changed before reconciliation");
    }
    if (params.retainOwnership !== true) {
      activeReservationTokens.delete(key);
    }
  };

  const cancel = (childIntentKey: string) => {
    const changed = deps.cancelPersisted(childIntentKey.trim());
    if (changed) {
      activeReservationTokens.delete(childIntentKey.trim());
    }
    return changed;
  };

  const takeForRegistration = (params: { childIntentKey?: string; reservationToken?: string }) => {
    const key = params.childIntentKey?.trim();
    if (
      !key ||
      !params.reservationToken ||
      activeReservationTokens.get(key) !== params.reservationToken
    ) {
      if (key && params.reservationToken) {
        throw new Error("child intent reservation is not owned by this host admission");
      }
      return undefined;
    }
    const reservation = find(key);
    if (!reservation || reservation.reservationOwnerToken !== params.reservationToken) {
      throw new Error("child intent reservation changed before registration");
    }
    // The row remains present until the registration transaction atomically
    // changes it to registered and binds the provider run.
    activeReservationTokens.delete(key);
    return { reservation, childIntentKey: key, reservationToken: params.reservationToken };
  };

  const adopt = (params: { childIntentKey: string; reservationToken: string }) => {
    const token = deps.claimPersisted({
      childIntentKey: params.childIntentKey,
      reservationOwnerToken: params.reservationToken,
    });
    if (!token) {
      return false;
    }
    activeReservationTokens.set(params.childIntentKey.trim(), token);
    return true;
  };

  const getReservationToken = (childIntentKey: string) =>
    activeReservationTokens.get(childIntentKey.trim());

  const abandonUnresolved = (params: { childIntentKey: string; reservationToken: string }) =>
    deps.removePersisted({
      childIntentKey: params.childIntentKey.trim(),
      reservationOwnerToken: params.reservationToken,
      allowUnknown: true,
    });

  const assertDispatchIdentityAvailable = (childIntentKey?: string, reservationToken?: string) => {
    const key = childIntentKey?.trim();
    if (!key) {
      return;
    }
    const existing = find(key);
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

  const restoreAfterRegistrationFailure = () => {
    // The durable row was never removed. Its dispatch/acceptance state remains
    // fenced and can be reconciled by a later host.
  };

  const expireStale = (now = Date.now()) => {
    const expiredRunIds = new Set(deps.expirePersisted(now));
    for (const [key] of activeReservationTokens) {
      if (expiredRunIds.has(find(key)?.runId ?? "")) {
        activeReservationTokens.delete(key);
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
    getReservationToken,
    abandonUnresolved,
    takeForRegistration,
    assertDispatchIdentityAvailable,
    restoreAfterRegistrationFailure,
    expireStale,
    reset: () => activeReservationTokens.clear(),
  };
}
