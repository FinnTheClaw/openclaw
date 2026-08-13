/**
 * Host-only capability kernel for the experimental behavior governor.
 *
 * This is intentionally not exported by the OpenClaw package.  It is for
 * application bootstrap and authenticated host integrations only: task,
 * model, tool, plugin, and governor modules must never import this module.
 * It does not defend a process/OS compromise that can inspect memory.
 */
import crypto from "node:crypto";
import { canonicalGovernorJson, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import { createHostApprovalCapabilities } from "./governor-host-approval-capabilities.js";
import {
  createHostBrokerResolvers,
  isTrustedGovernorApprovalResolver as isTrustedApprovalResolver,
  isTrustedGovernorEvidenceInvalidationResolver as isTrustedEvidenceResolver,
  isTrustedGovernorReceiptResolver as isTrustedReceiptResolver,
} from "./governor-host-broker-resolvers.js";
import type { GovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import type {
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedReceiptResolver,
  HostBrokerState,
  HostGovernorCapabilities,
  HostGovernorOwnerIngressReceiptId,
} from "./governor-host-contracts.js";
import {
  createHostGovernorDeliveryBroker,
  isTrustedGovernorDeliveryResolver,
} from "./governor-host-delivery-broker.js";
import { closeGovernorMemoryAuthority } from "./governor-host-memory-authority.js";
import {
  createHostOwnerIngressResolver,
  isTrustedGovernorOwnerIngressResolver as isTrustedOwnerIngressResolver,
} from "./governor-host-owner-ingress-resolver.js";
import {
  isGovernorHostPersistence,
  type GovernorHostPersistence,
} from "./governor-host-persistence.js";
import {
  closeGovernorPhysicalExecutionCoordinator,
  type GovernorTrustedPhysicalExecutionCoordinator,
} from "./governor-host-physical-execution.js";
import { createHostReceiptCapabilities } from "./governor-host-receipt-capabilities.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";
import { closeGovernorTaskAuthority } from "./governor-host-task-authority.js";
export type {
  GovernorAuthenticatedApprovalReceipt,
  GovernorAuthenticatedApprovalRevocation,
  GovernorAuthenticatedEvidenceInvalidation,
  GovernorEvidenceInvalidationProvenance,
  GovernorEvidenceInvalidationReason,
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedApprovalResolver,
  GovernorTrustedDeliveryResolver,
  GovernorTrustedOwnerIngressResolver,
  GovernorTrustedReceiptResolver,
  GovernorOwnerIngressClaim,
  HostGovernorApprovalReceiptId,
  HostGovernorEvidenceInvalidationReceiptId,
  HostGovernorApprovalRevocationId,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
  HostGovernorOwnerIngressReceiptId,
  HostGovernorOwnerIngressClaimToken,
  HostGovernorReceiptId,
  HostDeliveryReceipt,
} from "./governor-host-contracts.js";

const CAPABILITIES = new WeakSet<object>();
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
  return isTrustedReceiptResolver(resolver);
}

export function isTrustedGovernorEvidenceInvalidationResolver(
  resolver: GovernorTrustedEvidenceInvalidationResolver,
): boolean {
  return isTrustedEvidenceResolver(resolver);
}

export function isTrustedGovernorApprovalResolver(
  resolver: GovernorTrustedApprovalResolver,
): boolean {
  return isTrustedApprovalResolver(resolver);
}

export { isTrustedGovernorDeliveryResolver };

export function isTrustedGovernorOwnerIngressResolver(
  resolver: GovernorTrustedOwnerIngressResolver,
): boolean {
  return isTrustedOwnerIngressResolver(resolver);
}

/**
 * Called only by application bootstrap after it has resolved host secrets.
 * It deliberately takes a runtime-only key rather than loading any secret in
 * task-facing code.  The returned capabilities are object-capability scoped.
 */
export function createHostGovernorBroker(params: {
  secrets: GovernorSecrets;
  persistence: GovernorHostPersistence;
  deliveryRuntime?: GovernorHostDeliveryRuntime;
}): {
  capabilities: HostGovernorCapabilities;
  resolver: GovernorTrustedReceiptResolver;
  evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
  approvalResolver: GovernorTrustedApprovalResolver;
  deliveryResolver: GovernorTrustedDeliveryResolver;
  ownerIngressResolver: GovernorTrustedOwnerIngressResolver;
  physicalExecutionCoordinator: GovernorTrustedPhysicalExecutionCoordinator;
  memoryAuthority: import("./governor-host-memory-authority.js").GovernorTrustedMemoryAuthority;
  taskAuthority: import("./governor-host-task-authority.js").GovernorTrustedTaskAuthority;
  freeze: () => void;
  close: () => void;
} {
  if (!isGovernorSecrets(params.secrets) || !isGovernorHostPersistence(params.persistence)) {
    throw new Error("Host governor validated secrets and persistence are required");
  }
  const state: HostBrokerState = {
    key: params.secrets.receiptSigningKey,
    receipts: new Map(),
    evidenceInvalidations: new Map(),
    approvals: new Map(),
    revocations: new Map(),
    deliveries: new Map(),
    ownerIngress: new Map(),
  };
  const deliveryBroker = createHostGovernorDeliveryBroker({
    secrets: params.secrets,
    persistence: params.persistence,
    deliveries: state.deliveries,
    deliveryRuntime: params.deliveryRuntime,
  });
  const capability = {};
  CAPABILITIES.add(capability);
  let closing = false;
  let closed = false;
  let closeFailure: AggregateError | undefined;
  const assertOpen = () => {
    if (closing || closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  };
  const { submitObservedReceipt, submitEvidenceInvalidation } = createHostReceiptCapabilities({
    state,
    capability,
    isCapability: (value) => CAPABILITIES.has(value),
    sign,
    opaqueId,
  });
  const { submitAuthenticatedApproval, submitApprovalRevocation } = createHostApprovalCapabilities({
    state,
    capability,
    isCapability: (value) => CAPABILITIES.has(value),
    sign,
    opaqueId,
    targetOpaque: (target) => params.secrets.identity.opaqueReference("action-target", target),
    recordGrant: (grant) => params.persistence.recordApprovalGrant(grant),
    revokeGrant: (grant) => params.persistence.revokeApproval(grant),
  });
  const submitAuthenticatedOwnerIngress: HostGovernorCapabilities["submitAuthenticatedOwnerIngress"] =
    (input) => {
      if (!CAPABILITIES.has(capability)) {
        throw new Error("Governor host owner-ingress capability is invalid");
      }
      if (
        (input.channel !== "signal" && input.channel !== "imessage") ||
        !["approve", "enable", "reinvestigate", "repair", "revoke"].includes(input.action) ||
        !Number.isSafeInteger(input.sourceSequence) ||
        input.sourceSequence < 0 ||
        !Number.isSafeInteger(input.observedAt) ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= input.observedAt ||
        input.expiresAt - input.observedAt > 5 * 60_000
      ) {
        throw new Error("Governor owner-ingress envelope is invalid");
      }
      for (const value of [
        input.accountId,
        input.gatewayInstanceId,
        input.ownerPrincipal,
        input.sourceMessageId,
        input.scopeKey,
        input.nonce,
      ]) {
        if (!value.trim()) {
          throw new Error("Governor owner-ingress identity field is required");
        }
      }
      const body = {
        channel: input.channel,
        accountIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-account:${input.channel}`,
          input.accountId,
        ),
        gatewayIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-gateway:${input.channel}`,
          input.gatewayInstanceId,
        ),
        ownerPrincipalIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-principal:${input.channel}`,
          input.ownerPrincipal,
        ),
        sourceMessageIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-message:${input.channel}`,
          input.sourceMessageId,
        ),
        sourceBindingIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-source:${input.channel}`,
          canonicalGovernorJson({
            channel: input.channel,
            accountId: input.accountId,
            gatewayInstanceId: input.gatewayInstanceId,
            ownerPrincipal: input.ownerPrincipal,
            scopeKey: input.scopeKey,
            deploymentIdentity: params.secrets.deploymentIdentity,
          }),
        ),
        sourceSequence: input.sourceSequence,
        action: input.action,
        scopeKey: params.secrets.identity.opaqueReference("owner-ingress-scope", input.scopeKey),
        nonceIdentity: params.secrets.identity.opaqueReference(
          `owner-ingress-nonce:${input.channel}`,
          input.nonce,
        ),
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        deploymentIdentity: params.secrets.deploymentIdentity,
      };
      const id = opaqueId(state.key, { ownerIngress: body }) as HostGovernorOwnerIngressReceiptId;
      const receipt = Object.freeze({ id, ...body, signature: sign(state.key, { id, ...body }) });
      params.persistence.storeOwnerIngress(receipt);
      state.ownerIngress.set(id, receipt);
      return id;
    };
  const revokeOwnerIngressReceipt: HostGovernorCapabilities["revokeOwnerIngressReceipt"] = (
    input,
  ) => {
    if (!CAPABILITIES.has(capability)) {
      throw new Error("Governor host owner-ingress capability is invalid");
    }
    const receipt =
      state.ownerIngress.get(input.receiptId) ??
      params.persistence.loadOwnerIngress(input.receiptId);
    if (!receipt) {
      return false;
    }
    const { signature, consumedAt: _consumedAt, ...body } = receipt;
    if (sign(state.key, body) !== signature) {
      throw new Error("Governor owner-ingress receipt signature is invalid");
    }
    const revoked = params.persistence.revokeOwnerIngress({
      receipt,
      revokedAt: input.observedAt,
    });
    if (revoked) {
      state.ownerIngress.delete(input.receiptId);
    }
    return revoked;
  };
  const { resolver, evidenceInvalidationResolver, approvalResolver } = createHostBrokerResolvers({
    state,
    secrets: params.secrets,
    persistence: params.persistence,
    assertOpen,
    sign,
  });
  const ownerIngressResolver = createHostOwnerIngressResolver({
    state,
    key: state.key,
    secrets: params.secrets,
    persistence: params.persistence,
    assertOpen,
    sign,
    opaqueId,
  });
  const physicalExecutionCoordinator = params.persistence.physicalExecutions;
  const memoryAuthority = params.persistence.memoryAuthority;
  const taskAuthority = params.persistence.taskAuthority;
  const capabilities = Object.freeze({
    submitObservedReceipt: (input: Parameters<typeof submitObservedReceipt>[0]) => {
      assertOpen();
      return submitObservedReceipt(input);
    },
    submitEvidenceInvalidation: (input: Parameters<typeof submitEvidenceInvalidation>[0]) => {
      assertOpen();
      return submitEvidenceInvalidation(input);
    },
    submitAuthenticatedApproval: (input: Parameters<typeof submitAuthenticatedApproval>[0]) => {
      assertOpen();
      return submitAuthenticatedApproval(input);
    },
    submitApprovalRevocation: (input: Parameters<typeof submitApprovalRevocation>[0]) => {
      assertOpen();
      return submitApprovalRevocation(input);
    },
    registerStaticDeliveryAdapter: (input: Parameters<typeof deliveryBroker.register>[0]) => {
      assertOpen();
      return deliveryBroker.register(input);
    },
    revokeDeliveryAdapter: (input: Parameters<typeof deliveryBroker.revoke>[0]) => {
      assertOpen();
      return deliveryBroker.revoke(input);
    },
    resolveUnknownDelivery: (input: Parameters<typeof deliveryBroker.resolveUnknown>[0]) => {
      assertOpen();
      return deliveryBroker.resolveUnknown(input);
    },
    submitAuthenticatedOwnerIngress: (
      input: Parameters<typeof submitAuthenticatedOwnerIngress>[0],
    ) => {
      assertOpen();
      return submitAuthenticatedOwnerIngress(input);
    },
    revokeOwnerIngressReceipt: (input: Parameters<typeof revokeOwnerIngressReceipt>[0]) => {
      assertOpen();
      return revokeOwnerIngressReceipt(input);
    },
  }) satisfies HostGovernorCapabilities;
  const close = () => {
    if (closeFailure) {
      throw closeFailure;
    }
    if (closed) {
      return;
    }
    closing = true;
    const errors: unknown[] = [];
    try {
      deliveryBroker.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      closeGovernorPhysicalExecutionCoordinator(physicalExecutionCoordinator);
    } catch (error) {
      errors.push(error);
    }
    try {
      closeGovernorMemoryAuthority(memoryAuthority);
    } catch (error) {
      errors.push(error);
    }
    try {
      closeGovernorTaskAuthority(taskAuthority);
    } catch (error) {
      errors.push(error);
    }
    closed = true;
    if (errors.length > 0) {
      closeFailure = new AggregateError(errors, "GOVERNOR_HOST_DELIVERY_CLOSE_FAILED");
      throw closeFailure;
    }
  };
  return {
    capabilities,
    resolver,
    evidenceInvalidationResolver,
    approvalResolver,
    deliveryResolver: deliveryBroker.resolver,
    ownerIngressResolver,
    physicalExecutionCoordinator,
    memoryAuthority,
    taskAuthority,
    freeze: () => {
      closing = true;
    },
    close,
  };
}
