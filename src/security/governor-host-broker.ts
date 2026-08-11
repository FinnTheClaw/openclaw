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

type HostBrokerState = {
  readonly key: string;
  readonly receipts: Map<HostGovernorReceiptId, HostReceipt>;
};

const CAPABILITIES = new WeakSet<object>();
const RESOLVERS = new WeakSet<object>();

function sign(key: string, value: unknown): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: unknown): HostGovernorReceiptId {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}` as HostGovernorReceiptId;
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
};

/** Read-only resolver supplied to the controller; it cannot create receipts. */
export type GovernorTrustedReceiptResolver = {
  readonly resolve: (receiptId: HostGovernorReceiptId, scopeKey: string) => HostReceipt | null;
};

/** Internal construction check; a caller-created lookalike resolver is rejected. */
export function isTrustedGovernorReceiptResolver(
  resolver: GovernorTrustedReceiptResolver,
): boolean {
  return RESOLVERS.has(resolver);
}

/**
 * Called only by application bootstrap after it has resolved host secrets.
 * It deliberately takes a runtime-only key rather than loading any secret in
 * task-facing code.  The returned capabilities are object-capability scoped.
 */
export function createHostGovernorBroker(params: { receiptSigningKey: string }): {
  capabilities: HostGovernorCapabilities;
  resolver: GovernorTrustedReceiptResolver;
} {
  if (!params.receiptSigningKey.trim()) {
    throw new Error("Host governor receipt signing key is required");
  }
  const state: HostBrokerState = { key: params.receiptSigningKey, receipts: new Map() };
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
    const id = opaqueId(state.key, { ...body, nonce: crypto.randomUUID() });
    const receipt = Object.freeze({
      id,
      ...input,
      signature: sign(state.key, { id, ...body }),
    });
    state.receipts.set(id, receipt);
    return id;
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
  return {
    capabilities: Object.freeze({ submitObservedReceipt }),
    resolver,
  };
}
