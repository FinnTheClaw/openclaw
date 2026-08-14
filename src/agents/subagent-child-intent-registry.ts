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
  controllerSessionKey?: string;
  requestDigest?: string;
  resolvedDigest?: string;
  dispatchState?: "dispatching" | "unknown";
  durableReceiptRequired?: boolean;
};

type ChildIntentRegistryDependencies = {
  getRuns: () => Map<string, SubagentRunRecord>;
  reservePersisted: (
    entry: SubagentRunRecord,
    maxActiveChildren?: number,
  ) => SubagentRunRecord | null;
  findPersisted: (
    childIntentKey: string,
    controllerSessionKey: string,
  ) => SubagentRunRecord | undefined;
  transitionPersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    reservationOwnerToken: string;
    from: "reserved" | "dispatching" | "unknown";
    to: "dispatching" | "unknown" | "cancelled";
    providerRunId?: string;
    gatewayReceiptId?: string;
  }) => SubagentRunRecord | null;
  claimPersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    reservationOwnerToken: string;
  }) => string | false;
  cancelPersisted: (params: { childIntentKey: string; controllerSessionKey: string }) => boolean;
  removePersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    reservationOwnerToken?: string;
    onlyExpired?: boolean;
    allowUnknown?: boolean;
  }) => boolean;
  expirePersisted: (now: number) => string[];
};

export function createSubagentChildIntentRegistry(deps: ChildIntentRegistryDependencies) {
  const activeReservationTokens = new Map<string, string>();
  const controllerByKey = new Map<string, string>();
  const resolveController = (key: string) => {
    const normalized = key.trim();
    const fromMap = controllerByKey.get(normalized);
    if (fromMap) {
      return fromMap;
    }
    for (const entry of deps.getRuns().values()) {
      if (entry.childIntentKey === normalized || entry.childIntentLookupKey === normalized) {
        const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
        if (controller) {
          controllerByKey.set(normalized, controller);
          return controller;
        }
      }
    }
    return undefined;
  };
  const find = (key: string, controllerSessionKey?: string) => {
    const normalized = key.trim();
    const controller = controllerSessionKey?.trim() || resolveController(normalized);
    return controller ? deps.findPersisted(normalized, controller) : undefined;
  };

  const duplicate = (
    childIntentKey: string,
    entry: SubagentRunRecord,
  ): SubagentChildIntentReservation => {
    const existingRunId = entry.providerRunId ?? entry.runId;
    const canReconcile =
      (entry.spawnAdmission === "dispatching" || entry.spawnAdmission === "unknown") &&
      typeof entry.reservationOwnerToken === "string" &&
      !activeReservationTokens.has(childIntentKey);
    const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
    if (controller) {
      controllerByKey.set(childIntentKey, controller);
    }
    return {
      disposition: "duplicate",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: childIntentKey,
      existingRunId,
      controllerSessionKey: entry.controllerSessionKey,
      requestDigest: entry.childIntentRequestDigest,
      resolvedDigest: entry.childIntentBehaviorDigest,
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
      childIntentPreparationDigest: params.intentBehaviorDigest ?? childIntentKey,
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
      controllerByKey.set(childIntentKey, requesterSessionKey);
      if (persisted.requesterSessionKey !== requesterSessionKey) {
        throw new Error("child intent is already bound to another controller");
      }
      return duplicate(childIntentKey, persisted);
    }
    activeReservationTokens.set(childIntentKey, reservationOwnerToken);
    controllerByKey.set(childIntentKey, requesterSessionKey);
    return {
      disposition: "owner",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: entry.runId,
      reservationToken: reservationOwnerToken,
      controllerSessionKey: entry.controllerSessionKey,
      requestDigest: entry.childIntentRequestDigest,
      resolvedDigest: entry.childIntentBehaviorDigest,
    };
  };

  const release = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    if (activeReservationTokens.get(key) !== params.reservationToken) {
      return;
    }
    const controllerSessionKey = resolveController(key);
    if (
      !controllerSessionKey ||
      !deps.removePersisted({
        childIntentKey: key,
        controllerSessionKey,
        reservationOwnerToken: params.reservationToken,
      })
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
    const controllerSessionKey = resolveController(key);
    if (
      !controllerSessionKey ||
      !deps.transitionPersisted({
        childIntentKey: key,
        controllerSessionKey,
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
    const controllerSessionKey = resolveController(key);
    const entry = find(key);
    if (
      !entry ||
      !controllerSessionKey ||
      !deps.transitionPersisted({
        childIntentKey: key,
        controllerSessionKey,
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

  const cancel = (childIntentKey: string, controllerSessionKey?: string) => {
    const key = childIntentKey.trim();
    const controller = controllerSessionKey?.trim() || resolveController(key);
    const changed = controller
      ? deps.cancelPersisted({ childIntentKey: key, controllerSessionKey: controller })
      : false;
    if (changed) {
      activeReservationTokens.delete(key);
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
    const controllerSessionKey = resolveController(params.childIntentKey);
    if (!controllerSessionKey) {
      return false;
    }
    const token = deps.claimPersisted({
      childIntentKey: params.childIntentKey,
      controllerSessionKey,
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
    (() => {
      const key = params.childIntentKey.trim();
      const controllerSessionKey = resolveController(key);
      return controllerSessionKey
        ? deps.removePersisted({
            childIntentKey: key,
            controllerSessionKey,
            reservationOwnerToken: params.reservationToken,
            allowUnknown: true,
          })
        : false;
    })();

  const assertDispatchIdentityAvailable = (childIntentKey?: string, reservationToken?: string) => {
    const key = childIntentKey?.trim();
    if (!key) {
      return;
    }
    const controllerSessionKey = resolveController(key);
    const existing = find(key);
    if (
      !controllerSessionKey ||
      (existing &&
        (existing.spawnAdmission === "dispatched" ||
          existing.spawnAdmission === "cancelled" ||
          existing.spawnAdmission === "expired" ||
          (existing.spawnAdmission === "unknown" &&
            existing.reservationOwnerToken !== reservationToken)))
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
    reset: () => {
      activeReservationTokens.clear();
      controllerByKey.clear();
    },
  };
}
