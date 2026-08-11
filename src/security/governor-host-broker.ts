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

declare const hostReceiptIdBrand: unique symbol;
export type HostGovernorReceiptId = string & { readonly [hostReceiptIdBrand]: true };

declare const hostApprovalReceiptIdBrand: unique symbol;
export type HostGovernorApprovalReceiptId = string & {
  readonly [hostApprovalReceiptIdBrand]: true;
};

declare const hostApprovalRevocationIdBrand: unique symbol;
export type HostGovernorApprovalRevocationId = string & {
  readonly [hostApprovalRevocationIdBrand]: true;
};

declare const hostDeliveryHandleBrand: unique symbol;
export type HostGovernorDeliveryHandle = string & { readonly [hostDeliveryHandleBrand]: true };

type HostDeliveryIdentity = Readonly<{
  adapterId: string;
  version: string;
  capability: string;
}>;

type HostDeliveryEntry = Readonly<{
  handle: HostGovernorDeliveryHandle;
  identity: HostDeliveryIdentity;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  status: "certified" | "revoked";
  send: (params: { deliveryKey: string; payload: GovernorJsonValue }) => Promise<{
    deliveryKey: string;
    receipt: GovernorJsonValue;
  }>;
  signature: string;
}>;

type HostReceipt = Readonly<{
  id: HostGovernorReceiptId;
  scopeKey: string;
  taskId: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  sourceKind: "tool" | "structured_external" | "authenticated_user";
  sourceIdentity: string;
  payload: GovernorJsonValue;
  observedAt: number;
  signature: string;
}>;

export type GovernorAuthenticatedApprovalReceipt = Readonly<{
  id: HostGovernorApprovalReceiptId;
  scopeKey: string;
  taskId: string;
  objectiveRevision: number;
  capability: string;
  capabilityVersion: string;
  canonicalTarget: string;
  approverIdentity: string;
  approvalEpoch: number;
  expiresAt: number;
  observedAt: number;
  signature: string;
}>;

export type GovernorAuthenticatedApprovalRevocation = Readonly<{
  id: HostGovernorApprovalRevocationId;
  grantId: string;
  scopeKey: string;
  observedAt: number;
  signature: string;
}>;

type HostBrokerState = {
  readonly key: string;
  readonly receipts: Map<HostGovernorReceiptId, HostReceipt>;
  readonly approvals: Map<HostGovernorApprovalReceiptId, GovernorAuthenticatedApprovalReceipt>;
  readonly revocations: Map<
    HostGovernorApprovalRevocationId,
    GovernorAuthenticatedApprovalRevocation
  >;
  readonly deliveries: Map<HostGovernorDeliveryHandle, HostDeliveryEntry>;
};

const CAPABILITIES = new WeakSet<object>();
const RESOLVERS = new WeakSet<object>();
const APPROVAL_RESOLVERS = new WeakSet<object>();
const DELIVERY_RESOLVERS = new WeakSet<object>();

function sign(key: string, value: unknown): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: unknown): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

/** Opaque handle retained only by host bootstrap and authenticated integrations. */
export type HostGovernorCapabilities = {
  readonly submitObservedReceipt: (input: {
    scopeKey: string;
    taskId: string;
    taskVersion: number;
    objectiveRevision: number;
    planVersion: number;
    sourceKind: HostReceipt["sourceKind"];
    sourceIdentity: string;
    payload: GovernorJsonValue;
    observedAt: number;
  }) => HostGovernorReceiptId;
  readonly submitAuthenticatedApproval: (input: {
    scopeKey: string;
    taskId: string;
    objectiveRevision: number;
    capability: string;
    capabilityVersion: string;
    canonicalTarget: string;
    approverIdentity: string;
    approvalEpoch: number;
    expiresAt: number;
    observedAt: number;
  }) => HostGovernorApprovalReceiptId;
  readonly submitApprovalRevocation: (input: {
    grantId: string;
    scopeKey: string;
    observedAt: number;
  }) => HostGovernorApprovalRevocationId;
  readonly registerStaticDeliveryAdapter: (input: {
    identity: HostDeliveryIdentity;
    config: GovernorJsonValue;
    generation: number;
    factory: () => {
      send: HostDeliveryEntry["send"];
    };
  }) => HostGovernorDeliveryHandle;
  readonly revokeDeliveryAdapter: (input: { handle: HostGovernorDeliveryHandle }) => boolean;
};

/** Read-only resolver supplied to the controller; it cannot create receipts. */
export type GovernorTrustedReceiptResolver = {
  readonly resolve: (receiptId: HostGovernorReceiptId, scopeKey: string) => HostReceipt | null;
};

/** Read-only verifier retained by the governor store, never a host mutation capability. */
export type GovernorTrustedApprovalResolver = {
  readonly resolveApproval: (
    receiptId: HostGovernorApprovalReceiptId,
    scopeKey: string,
  ) => GovernorAuthenticatedApprovalReceipt | null;
  readonly resolveRevocation: (
    receiptId: HostGovernorApprovalRevocationId,
    scopeKey: string,
  ) => GovernorAuthenticatedApprovalRevocation | null;
  readonly signApprovalGrant: (grant: unknown) => { keyId: string; signature: string };
  readonly verifyApprovalGrant: (grant: unknown, keyId: string, signature: string) => boolean;
};

/** Read-only delivery resolution. It cannot register, rebind, or revoke adapters. */
export type GovernorTrustedDeliveryResolver = {
  readonly resolve: (handle: HostGovernorDeliveryHandle) => HostDeliveryEntry | null;
};

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
export function createHostGovernorBroker(params: { receiptSigningKey: string }): {
  capabilities: HostGovernorCapabilities;
  resolver: GovernorTrustedReceiptResolver;
  approvalResolver: GovernorTrustedApprovalResolver;
  deliveryResolver: GovernorTrustedDeliveryResolver;
} {
  if (!params.receiptSigningKey.trim()) {
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
    const body = { id, ...input };
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
    const implementation = input.factory();
    if (!implementation || typeof implementation.send !== "function") {
      throw new Error("Governor host delivery factory did not return a sender");
    }
    // Bind the callable now. Later mutation of the source object cannot alter dispatch.
    const send = implementation.send.bind(implementation);
    const identity = Object.freeze(structuredClone(input.identity));
    const configDigest = governorDigest(input.config);
    const implementationDigest = governorDigest({ source: String(implementation.send) });
    const handle = opaqueId(state.key, {
      delivery: { identity, configDigest, implementationDigest, generation: input.generation },
    }) as HostGovernorDeliveryHandle;
    const prior = state.deliveries.get(handle);
    if (prior && prior.status !== "revoked") {
      throw new Error("Governor delivery handle is already registered");
    }
    const unsigned = {
      handle,
      identity,
      implementationDigest,
      configDigest,
      generation: input.generation,
      status: "certified" as const,
    };
    state.deliveries.set(
      handle,
      Object.freeze({ ...unsigned, send, signature: sign(state.key, unsigned) }),
    );
    return handle;
  };
  const revokeDeliveryAdapter: HostGovernorCapabilities["revokeDeliveryAdapter"] = ({ handle }) => {
    if (!CAPABILITIES.has(capability))
      throw new Error("Governor host delivery capability is invalid");
    const prior = state.deliveries.get(handle);
    if (!prior || prior.status === "revoked") return false;
    const unsigned = {
      handle: prior.handle,
      identity: prior.identity,
      implementationDigest: prior.implementationDigest,
      configDigest: prior.configDigest,
      generation: prior.generation + 1,
      status: "revoked" as const,
    };
    state.deliveries.set(
      handle,
      Object.freeze({ ...unsigned, send: prior.send, signature: sign(state.key, unsigned) }),
    );
    return true;
  };
  const resolver: GovernorTrustedReceiptResolver = Object.freeze({
    resolve: (receiptId, scopeKey) => {
      const receipt = state.receipts.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) return null;
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
      if (!receipt || receipt.scopeKey !== scopeKey) return null;
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
    },
    resolveRevocation: (receiptId, scopeKey) => {
      const receipt = state.revocations.get(receiptId);
      if (!receipt || receipt.scopeKey !== scopeKey) return null;
      const { signature, ...body } = receipt;
      return sign(state.key, body) === signature ? receipt : null;
    },
    signApprovalGrant: (grant) => ({ keyId: "host-broker-v1", signature: sign(state.key, grant) }),
    verifyApprovalGrant: (grant, keyId, signature) =>
      keyId === "host-broker-v1" && sign(state.key, grant) === signature,
  });
  APPROVAL_RESOLVERS.add(approvalResolver);
  const deliveryResolver: GovernorTrustedDeliveryResolver = Object.freeze({
    resolve: (handle) => {
      const entry = state.deliveries.get(handle);
      if (!entry) return null;
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
