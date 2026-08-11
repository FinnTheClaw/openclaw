/** Type-only contracts shared by the private governor host broker and its read-only bridge. */
import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";

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

declare const hostOwnerIngressReceiptBrand: unique symbol;
export type HostGovernorOwnerIngressReceiptId = string & {
  readonly [hostOwnerIngressReceiptBrand]: true;
};

export type GovernorOwnerAction = "approve" | "enable" | "reinvestigate" | "repair" | "revoke";

export type HostDeliveryIdentity = Readonly<{
  adapterId: string;
  version: string;
  capability: string;
}>;

export type HostDeliveryBinding = Readonly<{
  channel: "canary" | "imessage" | "signal";
  accountIdentity: string;
  targetIdentity: string;
  deploymentIdentity: string;
  mode: "active" | "shadow";
}>;

export type HostDeliveryReceipt = Readonly<{
  kind: "host_delivery_receipt";
  handle: HostGovernorDeliveryHandle;
  identityKey: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  deploymentIdentity: string;
  deliveryKey: string;
  payloadDigest: string;
  outcome: "sent" | "would_send";
  providerReceiptDigest: string;
  observedAt: number;
  keyId: "host-broker-v1";
  keyVersion: 1;
  signature: string;
}>;

export type HostDeliveryDispatchResult =
  | Readonly<{ status: "sent" | "would_send"; receipt: HostDeliveryReceipt }>
  | Readonly<{ status: "unknown"; reasonDigest: string; reconcileSupported: boolean }>
  | Readonly<{ status: "not_sent"; reasonDigest: string }>;

export type HostDeliveryReconciliationResult =
  | Readonly<{ status: "sent"; receipt: HostDeliveryReceipt }>
  | Readonly<{ status: "not_sent" }>
  | Readonly<{ status: "unresolved" }>;

export type HostDeliveryEntry = Readonly<{
  handle: HostGovernorDeliveryHandle;
  identityKey: string;
  identity: HostDeliveryIdentity;
  implementationId: string;
  implementationDigest: string;
  configDigest: string;
  generation: number;
  status: "certified" | "revoked";
  binding: HostDeliveryBinding;
  send: (params: {
    deliveryKey: string;
    payload: GovernorJsonValue;
  }) => Promise<HostDeliveryDispatchResult>;
  reconcile: (params: {
    deliveryKey: string;
    payloadDigest: string;
  }) => Promise<HostDeliveryReconciliationResult>;
  signature: string;
}>;

export type GovernorOwnerIngressReceipt = Readonly<{
  id: HostGovernorOwnerIngressReceiptId;
  channel: "imessage" | "signal";
  accountIdentity: string;
  gatewayIdentity: string;
  ownerPrincipalIdentity: string;
  sourceMessageIdentity: string;
  sourceSequence: number;
  action: GovernorOwnerAction;
  scopeKey: string;
  nonceIdentity: string;
  observedAt: number;
  expiresAt: number;
  deploymentIdentity: string;
  consumedAt?: number;
  signature: string;
}>;

export type HostReceipt = Readonly<{
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
  grantId: string;
  scopeKey: string;
  taskId: string;
  objectiveRevision: number;
  capability: string;
  capabilityVersion: string;
  canonicalTargetOpaque: string;
  approverIdentity: string;
  approvalEpoch: number;
  expiresAt: number;
  observedAt: number;
  grantKeyId: string;
  grantSignature: string;
  signature: string;
}>;

export type GovernorAuthenticatedApprovalRevocation = Readonly<{
  id: HostGovernorApprovalRevocationId;
  grantId: string;
  scopeKey: string;
  observedAt: number;
  signature: string;
}>;

export type HostBrokerState = {
  readonly key: string;
  readonly receipts: Map<HostGovernorReceiptId, HostReceipt>;
  readonly approvals: Map<HostGovernorApprovalReceiptId, GovernorAuthenticatedApprovalReceipt>;
  readonly revocations: Map<
    HostGovernorApprovalRevocationId,
    GovernorAuthenticatedApprovalRevocation
  >;
  readonly deliveries: Map<HostGovernorDeliveryHandle, HostDeliveryEntry>;
  readonly ownerIngress: Map<HostGovernorOwnerIngressReceiptId, GovernorOwnerIngressReceipt>;
};

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
    implementationId: string;
    config: GovernorJsonValue;
    generation: number;
  }) => HostGovernorDeliveryHandle;
  readonly revokeDeliveryAdapter: (input: { handle: HostGovernorDeliveryHandle }) => boolean;
  readonly submitAuthenticatedOwnerIngress: (input: {
    channel: "imessage" | "signal";
    accountId: string;
    gatewayInstanceId: string;
    ownerPrincipal: string;
    sourceMessageId: string;
    sourceSequence: number;
    action: GovernorOwnerAction;
    scopeKey: string;
    nonce: string;
    observedAt: number;
    expiresAt: number;
  }) => HostGovernorOwnerIngressReceiptId;
};

export type GovernorTrustedReceiptResolver = {
  readonly resolve: (receiptId: HostGovernorReceiptId, scopeKey: string) => HostReceipt | null;
};

export type GovernorTrustedApprovalResolver = {
  readonly resolveApproval: (
    receiptId: HostGovernorApprovalReceiptId,
    scopeKey: string,
  ) => GovernorAuthenticatedApprovalReceipt | null;
  readonly resolveRevocation: (
    receiptId: HostGovernorApprovalRevocationId,
    scopeKey: string,
  ) => GovernorAuthenticatedApprovalRevocation | null;
  readonly verifyApprovalGrant: (
    grant: {
      grantId: string;
      taskId: string;
      scopeKey: string;
      objectiveRevision: number;
      capability: string;
      capabilityVersion: string;
      canonicalTarget: string;
      issuerId: string;
      approvalEpoch: number;
      expiresAt: number;
      authorityKeyId: string;
      authorityVersion: number;
      authoritySignature: string;
    },
    canonicalTarget: string,
  ) => boolean;
};

export type GovernorTrustedDeliveryResolver = {
  readonly resolve: (handle: HostGovernorDeliveryHandle) => HostDeliveryEntry | null;
  readonly verifyReceipt: (receipt: HostDeliveryReceipt) => boolean;
};

export type GovernorTrustedOwnerIngressResolver = {
  readonly resolve: (
    receiptId: HostGovernorOwnerIngressReceiptId,
    now: number,
  ) => GovernorOwnerIngressReceipt | null;
  readonly markConsumed: (receiptId: HostGovernorOwnerIngressReceiptId, now: number) => boolean;
};
