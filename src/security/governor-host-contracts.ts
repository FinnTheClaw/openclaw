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

export type HostDeliveryIdentity = Readonly<{
  adapterId: string;
  version: string;
  capability: string;
}>;

export type HostDeliveryEntry = Readonly<{
  handle: HostGovernorDeliveryHandle;
  identityKey: string;
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
    identity: HostDeliveryIdentity;
    config: GovernorJsonValue;
    generation: number;
    send: (params: {
      config: GovernorJsonValue;
      deliveryKey: string;
      payload: GovernorJsonValue;
    }) => Promise<{ deliveryKey: string; receipt: GovernorJsonValue }>;
  }) => HostGovernorDeliveryHandle;
  readonly revokeDeliveryAdapter: (input: { handle: HostGovernorDeliveryHandle }) => boolean;
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
};
