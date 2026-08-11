/**
 * Host-only capability kernel for the experimental behavior governor.
 *
 * This is intentionally not exported by the OpenClaw package.  It is for
 * application bootstrap and authenticated host integrations only: task,
 * model, tool, plugin, and governor modules must never import this module.
 * It does not defend a process/OS compromise that can inspect memory.
 */
import crypto from "node:crypto";
import {
  canonicalGovernorJson,
  governorDigest,
  type GovernorJsonValue,
} from "../tasks/governor/canonical-json.js";
import type {
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedReceiptResolver,
  HostBrokerState,
  HostDeliveryEntry,
  HostGovernorApprovalReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";
import {
  isGovernorHostPersistence,
  type GovernorHostPersistence,
} from "./governor-host-persistence.js";
export type {
  GovernorAuthenticatedApprovalReceipt,
  GovernorAuthenticatedApprovalRevocation,
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedReceiptResolver,
  HostGovernorApprovalReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";

const CAPABILITIES = new WeakSet<object>();
const RESOLVERS = new WeakSet<object>();
const APPROVAL_RESOLVERS = new WeakSet<object>();
const DELIVERY_RESOLVERS = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function sign(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: GovernorJsonValue): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

/** Internal construction check; a caller-created lookalike resolver is rejected. */
export function isTrustedGovernorReceiptResolver(
  resolver: GovernorTrustedReceiptResolver,
): boolean {
  return RESOLVERS.has(resolver);
}

export function isTrustedGovernorApprovalResolver(
  resolver: GovernorTrustedApprovalResolver,
): boolean {
  return APPROVAL_RESOLVERS.has(resolver);
}

export function isTrustedGovernorDeliveryResolver(
  resolver: GovernorTrustedDeliveryResolver,
): boolean {
  return DELIVERY_RESOLVERS.has(resolver);
}

/**
 * Called only by application bootstrap after it has resolved host secrets.
 * It deliberately takes a runtime-only key rather than loading any secret in
 * task-facing code.  The returned capabilities are object-capability scoped.
 */
export function createHostGovernorBroker(params: {
  receiptSigningKey: string;
  persistence: GovernorHostPersistence;
}): {
  capabilities: HostGovernorCapabilities;
  resolver: GovernorTrustedReceiptResolver;
  approvalResolver: GovernorTrustedApprovalResolver;
  deliveryResolver: GovernorTrustedDeliveryResolver;
} {
  if (!params.receiptSigningKey.trim() || !isGovernorHostPersistence(params.persistence)) {
    throw new Error("Host governor receipt signing key is required");
  }
  const state: HostBrokerState = {
    key: params.receiptSigningKey,
    receipts: new Map(),
    approvals: new Map(),
    revocations: new Map(),
    deliveries: new Map(),
  };
  const capability = {};
  CAPABILITIES.add(capability);
  const submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"] = (input) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host receipt capability is invalid");
    }
    const body = {
      scopeKey: input.scopeKey,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      objectiveRevision: input.objectiveRevision,
      planVersion: input.planVersion,
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      payloadDigest: governorDigest(input.payload),
      observedAt: input.observedAt,
    };
    const id = opaqueId(state.key, {
      ...body,
      nonce: crypto.randomUUID(),
    }) as HostGovernorReceiptId;
    const receipt = Object.freeze({
      id,
      ...input,
      signature: sign(state.key, { id, ...body }),
    });
    state.receipts.set(id, receipt);
    return id;
  };
  const submitAuthenticatedApproval: HostGovernorCapabilities["submitAuthenticatedApproval"] = (
    input,
  ) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host approval capability is invalid");
    }
    const id = opaqueId(state.key, {
      approval: input,
      nonce: crypto.randomUUID(),
    }) as HostGovernorApprovalReceiptId;
    const grantId = `ggrant_${crypto.randomUUID()}`;
    const canonicalTargetOpaque = opaqueId(state.key, { target: input.canonicalTarget });
    const grantPayload = {
      grantId,
      taskId: input.taskId,
      scopeKey: input.scopeKey,
      objectiveRevision: input.objectiveRevision,
      capability: input.capability,
      capabilityVersion: input.capabilityVersion,
      canonicalTargetOpaque,
      approvalReceiptId: id,
      approvalEpoch: input.approvalEpoch,
      expiresAt: input.expiresAt,
    };
    const body = {
      id,
      grantId,
      canonicalTargetOpaque,
      grantKeyId: "host-broker-v1",
      grantSignature: sign(state.key, grantPayload),
      ...input,
    };
    params.persistence.recordApprovalGrant({
      grantId,
      scopeKey: input.scopeKey,
      approvalEpoch: input.approvalEpoch,
      observedAt: input.observedAt,
    });
    state.approvals.set(id, Object.freeze({ ...body, signature: sign(state.key, body) }));
    return id;
  };
  const submitApprovalRevocation: HostGovernorCapabilities["submitApprovalRevocation"] = (
    input,
  ) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host approval capability is invalid");
    }
    const id = opaqueId(state.key, {
      revocation: input,
      nonce: crypto.randomUUID(),
    }) as HostGovernorApprovalRevocationId;
    // Commit the durable high-water before exposing a successful revocation.
    if (
      !params.persistence.revokeApproval({
        grantId: input.grantId,
        scopeKey: input.scopeKey,
        observedAt: input.observedAt,
      })
    ) {
      throw new Error("Governor approval revocation was not durably applied");
    }
    const body = { id, ...input };
    state.revocations.set(id, Object.freeze({ ...body, signature: sign(state.key, body) }));
    return id;
  };
  const registerStaticDeliveryAdapter: HostGovernorCapabilities["registerStaticDeliveryAdapter"] = (
    input,
  ) => {
    if (
      !CAPABILITIES.has(capability) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    ) {
      throw new Error("Governor host delivery capability is invalid");
    }
    if (typeof input.send !== "function") {
      throw new Error("Governor host delivery capability requires a sender");
    }
    const identity = Object.freeze(structuredClone(input.identity));
    const config = deepFreeze(structuredClone(input.config));
    // Capture the bare callable and a frozen value snapshot. This never retains
    // a caller-owned adapter object or invokes a method through mutable `this`.
    const implementation = input.send;
    const send: HostDeliveryEntry["send"] = ({ deliveryKey, payload }) =>
      implementation({ config, deliveryKey, payload });
    const priorIdentity = Array.from(state.deliveries.values()).find(
      (entry) =>
        entry.identity.adapterId === identity.adapterId &&
        entry.identity.version === identity.version &&
        entry.identity.capability === identity.capability,
    );
    if (priorIdentity && input.generation <= priorIdentity.generation) {
      throw new Error("Governor delivery identity generation is already registered");
    }
    const identityKey = opaqueId(state.key, { deliveryIdentity: identity });
    const configDigest = governorDigest(config);
    const implementationDigest = governorDigest({ source: String(implementation) });
    const handle = opaqueId(state.key, {
      delivery: { identity, configDigest, implementationDigest, generation: input.generation },
    }) as HostGovernorDeliveryHandle;
    const prior = state.deliveries.get(handle);
    if (prior && prior.status !== "revoked") {
      throw new Error("Governor delivery handle is already registered");
    }
    const unsigned = {
      handle,
      identityKey,
      identity,
      implementationDigest,
      configDigest,
      generation: input.generation,
      status: "certified" as const,
    };
    const signature = sign(state.key, unsigned);
    // Journal certification before any replayable primary row is reconciled.
    params.persistence.certifyDelivery({
      handle,
      identityKey,
      implementationDigest,
      configDigest,
      generation: input.generation,
      signature,
      observedAt: Date.now(),
    });
    state.deliveries.set(handle, Object.freeze({ ...unsigned, send, signature }));
    return handle;
  };
  const revokeDeliveryAdapter: HostGovernorCapabilities["revokeDeliveryAdapter"] = ({ handle }) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host delivery capability is invalid");
    }
    const prior = state.deliveries.get(handle);
    if (!prior || prior.status === "revoked") {
      return false;
    }
    const unsigned = {
      handle: prior.handle,
      identityKey: prior.identityKey,
      identity: prior.identity,
      implementationDigest: prior.implementationDigest,
      configDigest: prior.configDigest,
      generation: prior.generation + 1,
      status: "revoked" as const,
    };
    const signature = sign(state.key, unsigned);
    // This is the transaction boundary. A cache update only follows a commit.
    if (
      !params.persistence.revokeDelivery({
        handle: prior.handle,
        identityKey: prior.identityKey,
        implementationDigest: prior.implementationDigest,
        configDigest: prior.configDigest,
        generation: unsigned.generation,
        signature,
        observedAt: Date.now(),
      })
    ) {
      throw new Error("Governor delivery revocation was not durably applied");
    }
    state.deliveries.set(handle, Object.freeze({ ...unsigned, send: prior.send, signature }));
    return true;
  };
  const resolver: GovernorTrustedReceiptResolver = Object.freeze({
    resolve: (receiptId, scopeKey) => {
      const receipt = state.receipts.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const body = {
        scopeKey: receipt.scopeKey,
        taskId: receipt.taskId,
        taskVersion: receipt.taskVersion,
        objectiveRevision: receipt.objectiveRevision,
        planVersion: receipt.planVersion,
        sourceKind: receipt.sourceKind,
        sourceIdentity: receipt.sourceIdentity,
        payloadDigest: governorDigest(receipt.payload),
        observedAt: receipt.observedAt,
      };
      const expected = sign(state.key, { id: receipt.id, ...body });
      return expected === receipt.signature ? receipt : null;
    },
  });
  RESOLVERS.add(resolver);
  const approvalResolver: GovernorTrustedApprovalResolver = Object.freeze({
    resolveApproval: (receiptId, scopeKey) => {
      const receipt = state.approvals.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
    },
    resolveRevocation: (receiptId, scopeKey) => {
      const receipt = state.revocations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) {
        return null;
      }
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
    },
    verifyApprovalGrant: (grant, canonicalTarget) => {
      if (grant.authorityKeyId !== "host-broker-v1" || grant.authorityVersion !== 1) {
        return false;
      }
      const canonicalTargetOpaque = opaqueId(state.key, { target: canonicalTarget });
      if (canonicalTargetOpaque !== grant.canonicalTarget) {
        return false;
      }
      const payload = {
        grantId: grant.grantId,
        taskId: grant.taskId,
        scopeKey: grant.scopeKey,
        objectiveRevision: grant.objectiveRevision,
        capability: grant.capability,
        capabilityVersion: grant.capabilityVersion,
        canonicalTargetOpaque: grant.canonicalTarget,
        approvalReceiptId: grant.issuerId,
        approvalEpoch: grant.approvalEpoch,
        expiresAt: grant.expiresAt,
      };
      return (
        sign(state.key, payload) === grant.authoritySignature &&
        params.persistence.approvalGrantMatches({
          grantId: grant.grantId,
          scopeKey: grant.scopeKey,
          approvalEpoch: grant.approvalEpoch,
        })
      );
    },
  });
  APPROVAL_RESOLVERS.add(approvalResolver);
  const deliveryResolver: GovernorTrustedDeliveryResolver = Object.freeze({
    resolve: (handle) => {
      const entry = state.deliveries.get(handle);
      if (!entry) {
        return null;
      }
      const durableState = params.persistence.deliveryState(entry.identityKey);
      if (
        !durableState ||
        durableState.generation !== entry.generation ||
        durableState.status !== "certified" ||
        !params.persistence.deliveryBindingMatches({
          handle: entry.handle,
          identityKey: entry.identityKey,
          implementationDigest: entry.implementationDigest,
          configDigest: entry.configDigest,
          generation: entry.generation,
          signature: entry.signature,
          observedAt: 0,
          status: entry.status,
        })
      ) {
        return null;
      }
      const { send: _send, signature, ...unsigned } = entry;
      return sign(state.key, unsigned) === signature ? entry : null;
    },
  });
  DELIVERY_RESOLVERS.add(deliveryResolver);
  return {
    capabilities: Object.freeze({
      submitObservedReceipt,
      submitAuthenticatedApproval,
      submitApprovalRevocation,
      registerStaticDeliveryAdapter,
      revokeDeliveryAdapter,
    }),
    resolver,
    approvalResolver,
    deliveryResolver,
  };
}
