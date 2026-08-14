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
  operationKey?: string;
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
    operationKey?: string,
  ) => SubagentRunRecord | undefined;
  transitionPersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    operationKey?: string;
    reservationOwnerToken: string;
    from: "reserved" | "dispatching" | "unknown";
    to: "dispatching" | "unknown" | "cancelled";
    providerRunId?: string;
    gatewayReceiptId?: string;
  }) => SubagentRunRecord | null;
  claimPersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    operationKey?: string;
    reservationOwnerToken: string;
  }) => string | false;
  cancelPersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    operationKey?: string;
  }) => boolean;
  removePersisted: (params: {
    childIntentKey: string;
    controllerSessionKey: string;
    operationKey?: string;
    reservationOwnerToken?: string;
    onlyExpired?: boolean;
    allowUnknown?: boolean;
  }) => boolean;
  expirePersisted: (now: number) => string[];
};

export function createSubagentChildIntentRegistry(deps: ChildIntentRegistryDependencies) {
  const activeReservationTokens = new Map<string, string>();
  const controllerByIdentity = new Map<string, string>();
  const identityKey = (controller: string, key: string, operationKey?: string) =>
    `${controller}\u0000${operationKey?.trim() ? `operation:${operationKey.trim()}` : `canonical:${key}`}`;
  const resolveController = (key: string, explicit?: string) => {
    const normalized = key.trim();
    if (explicit?.trim()) {
      return explicit.trim();
    }
    const candidates = new Set<string>();
    for (const [identity, controller] of controllerByIdentity) {
      if (identity.endsWith(`\u0000canonical:${normalized}`)) {
        candidates.add(controller);
      }
    }
    for (const entry of deps.getRuns().values()) {
      if (entry.childIntentKey === normalized || entry.childIntentLookupKey === normalized) {
        const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
        if (controller) {
          candidates.add(controller);
        }
      }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const resolveIdentity = (
    key: string,
    token?: string,
    explicit?: string,
    operationKey?: string,
  ) => {
    const normalized = key.trim();
    if (explicit?.trim()) {
      return identityKey(explicit.trim(), normalized, operationKey);
    }
    if (token) {
      const match = [...activeReservationTokens.entries()].find(([, value]) => value === token);
      if (match) {
        return match[0];
      }
    }
    const controller = resolveController(normalized);
    return controller ? identityKey(controller, normalized) : undefined;
  };
  const find = (key: string, controllerSessionKey?: string, operationKey?: string) => {
    const normalized = key.trim();
    const controller = controllerSessionKey?.trim() || resolveController(normalized);
    return controller ? deps.findPersisted(normalized, controller, operationKey) : undefined;
  };
  const identityParts = (identity: string) => {
    const separator = identity.indexOf("\u0000");
    const authority = identity.slice(0, separator);
    const slot = identity.slice(separator + 1);
    return {
      controllerSessionKey: authority,
      operationKey: slot.startsWith("operation:") ? slot.slice("operation:".length) : undefined,
    };
  };

  const duplicate = (
    childIntentKey: string,
    entry: SubagentRunRecord,
    durableReceiptRequired = false,
  ): SubagentChildIntentReservation => {
    const existingRunId = entry.providerRunId ?? entry.runId;
    const canReconcile =
      (entry.spawnAdmission === "dispatching" || entry.spawnAdmission === "unknown") &&
      typeof entry.reservationOwnerToken === "string" &&
      !activeReservationTokens.has(
        identityKey(
          (entry.controllerSessionKey ?? entry.requesterSessionKey).trim(),
          childIntentKey,
          entry.childIntentOperationKey,
        ),
      );
    const controller = (entry.controllerSessionKey ?? entry.requesterSessionKey).trim();
    if (controller) {
      const identity = identityKey(controller, childIntentKey, entry.childIntentOperationKey);
      controllerByIdentity.set(identity, controller);
      if (canReconcile && entry.reservationOwnerToken) {
        activeReservationTokens.set(identity, entry.reservationOwnerToken);
      }
    }
    return {
      disposition: "duplicate",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: childIntentKey,
      existingRunId,
      controllerSessionKey: entry.controllerSessionKey,
      operationKey: entry.childIntentOperationKey,
      requestDigest: entry.childIntentRequestDigest,
      resolvedDigest: entry.childIntentBehaviorDigest,
      ...(durableReceiptRequired && entry.childIntentKey ? { durableReceiptRequired: true } : {}),
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
    durableReceiptRequired?: boolean;
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
      controllerByIdentity.set(
        identityKey(requesterSessionKey, childIntentKey, params.operationKey),
        requesterSessionKey,
      );
      if (persisted.requesterSessionKey !== requesterSessionKey) {
        throw new Error("child intent is already bound to another controller");
      }
      return duplicate(childIntentKey, persisted, params.durableReceiptRequired === true);
    }
    activeReservationTokens.set(
      identityKey(requesterSessionKey, childIntentKey, params.operationKey),
      reservationOwnerToken,
    );
    controllerByIdentity.set(
      identityKey(requesterSessionKey, childIntentKey, params.operationKey),
      requesterSessionKey,
    );
    return {
      disposition: "owner",
      childIntentKey,
      childSessionKey: entry.childSessionKey,
      reservationRunId: entry.runId,
      reservationToken: reservationOwnerToken,
      controllerSessionKey: entry.controllerSessionKey,
      requestDigest: entry.childIntentRequestDigest,
      resolvedDigest: entry.childIntentBehaviorDigest,
      operationKey: entry.childIntentOperationKey,
      durableReceiptRequired: params.durableReceiptRequired === true,
    };
  };

  const release = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    const identity = resolveIdentity(key, params.reservationToken);
    if (!identity || activeReservationTokens.get(identity) !== params.reservationToken) {
      return;
    }
    const controllerSessionKey = identity.slice(0, identity.indexOf("\u0000"));
    const { operationKey } = identityParts(identity);
    if (
      !controllerSessionKey ||
      !deps.removePersisted({
        childIntentKey: key,
        controllerSessionKey,
        operationKey,
        reservationOwnerToken: params.reservationToken,
      })
    ) {
      throw new Error("child intent reservation changed before release");
    }
    activeReservationTokens.delete(identity);
  };

  const markDispatching = (params: { childIntentKey: string; reservationToken: string }) => {
    const key = params.childIntentKey.trim();
    const identity = resolveIdentity(key, params.reservationToken);
    if (!identity || activeReservationTokens.get(identity) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    const controllerSessionKey = identity.slice(0, identity.indexOf("\u0000"));
    const { operationKey } = identityParts(identity);
    if (
      !controllerSessionKey ||
      !deps.transitionPersisted({
        childIntentKey: key,
        controllerSessionKey,
        operationKey,
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
    durableReceiptRequired?: boolean;
    operationKey?: string;
    gatewayReceiptId?: string;
  }) => {
    const key = params.childIntentKey.trim();
    const identity = resolveIdentity(key, params.reservationToken);
    if (!identity || activeReservationTokens.get(identity) !== params.reservationToken) {
      throw new Error("child intent reservation is not owned by this host admission");
    }
    const controllerSessionKey = identity.slice(0, identity.indexOf("\u0000"));
    const { operationKey } = identityParts(identity);
    const entry = find(key, controllerSessionKey, operationKey);
    if (
      !entry ||
      !controllerSessionKey ||
      !deps.transitionPersisted({
        childIntentKey: key,
        controllerSessionKey,
        operationKey,
        reservationOwnerToken: params.reservationToken,
        from: entry.spawnAdmission === "dispatching" ? "dispatching" : "reserved",
        to: "unknown",
        providerRunId: params.providerRunId,
        ...(params.durableReceiptRequired
          ? { gatewayReceiptId: params.gatewayReceiptId ?? params.childIntentKey }
          : {}),
      })
    ) {
      throw new Error("child intent reservation changed before reconciliation");
    }
    if (params.retainOwnership !== true) {
      activeReservationTokens.delete(identity);
    }
  };

  const cancel = (childIntentKey: string, controllerSessionKey: string, operationKey?: string) => {
    const key = childIntentKey.trim();
    const controller = controllerSessionKey.trim();
    if (!controller) {
      return false;
    }
    const changed = deps.cancelPersisted({
      childIntentKey: key,
      controllerSessionKey: controller,
      operationKey,
    });
    if (changed) {
      const identity = identityKey(controller, key, operationKey);
      activeReservationTokens.delete(identity);
    }
    return changed;
  };

  const takeForRegistration = (params: { childIntentKey?: string; reservationToken?: string }) => {
    const key = params.childIntentKey?.trim();
    const identity =
      key && params.reservationToken ? resolveIdentity(key, params.reservationToken) : undefined;
    if (
      !key ||
      !params.reservationToken ||
      !identity ||
      activeReservationTokens.get(identity) !== params.reservationToken
    ) {
      if (key && params.reservationToken) {
        throw new Error("child intent reservation is not owned by this host admission");
      }
      return undefined;
    }
    const controller = identity!.slice(0, identity!.indexOf("\u0000"));
    const { operationKey } = identityParts(identity);
    const reservation = find(key, controller, operationKey);
    if (!reservation || reservation.reservationOwnerToken !== params.reservationToken) {
      throw new Error("child intent reservation changed before registration");
    }
    // The row remains present until the registration transaction atomically
    // changes it to registered and binds the provider run.
    activeReservationTokens.delete(identity!);
    return { reservation, childIntentKey: key, reservationToken: params.reservationToken };
  };

  const adopt = (params: { childIntentKey: string; reservationToken: string }) => {
    const identity = resolveIdentity(params.childIntentKey, params.reservationToken);
    if (!identity) {
      return false;
    }
    const controllerSessionKey = identity.slice(0, identity.indexOf("\u0000"));
    const { operationKey } = identityParts(identity);
    const token = deps.claimPersisted({
      childIntentKey: params.childIntentKey,
      controllerSessionKey,
      operationKey,
      reservationOwnerToken: params.reservationToken,
    });
    if (!token) {
      return false;
    }
    activeReservationTokens.set(
      identityKey(controllerSessionKey, params.childIntentKey.trim(), operationKey),
      token,
    );
    return true;
  };

  const getReservationToken = (
    childIntentKey: string,
    controllerSessionKey?: string,
    operationKey?: string,
  ) => {
    const identity = resolveIdentity(childIntentKey, undefined, controllerSessionKey, operationKey);
    return identity ? activeReservationTokens.get(identity) : undefined;
  };

  const abandonUnresolved = (params: { childIntentKey: string; reservationToken: string }) =>
    (() => {
      const key = params.childIntentKey.trim();
      const identity = resolveIdentity(key, params.reservationToken);
      if (!identity) {
        return false;
      }
      const controllerSessionKey = identity.slice(0, identity.indexOf("\u0000"));
      return controllerSessionKey
        ? deps.removePersisted({
            childIntentKey: key,
            controllerSessionKey,
            operationKey: identityParts(identity).operationKey,
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
    const identity = resolveIdentity(key, reservationToken);
    const controllerSessionKey = identity?.slice(0, identity.indexOf("\u0000"));
    const { operationKey } = identity ? identityParts(identity) : { operationKey: undefined };
    const existing = controllerSessionKey
      ? find(key, controllerSessionKey, operationKey)
      : undefined;
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
    for (const [identity] of activeReservationTokens) {
      const separator = identity.indexOf("\u0000");
      const controller = identity.slice(0, separator);
      const key = identity.slice(separator + 1);
      if (expiredRunIds.has(find(key, controller)?.runId ?? "")) {
        activeReservationTokens.delete(identity);
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
      controllerByIdentity.clear();
    },
  };
}
