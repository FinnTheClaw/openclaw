import crypto from "node:crypto";
import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { HostBrokerState, HostGovernorCapabilities } from "./governor-host-contracts.js";

export function createHostApprovalCapabilities(params: {
  state: HostBrokerState;
  capability: object;
  isCapability: (value: object) => boolean;
  sign: (key: string, value: GovernorJsonValue) => string;
  opaqueId: (key: string, value: GovernorJsonValue) => string;
  targetOpaque: (target: string) => string;
  recordGrant: (grant: {
    grantId: string;
    scopeKey: string;
    approvalEpoch: number;
    observedAt: number;
  }) => void;
  revokeGrant: (grant: { grantId: string; scopeKey: string; observedAt: number }) => boolean;
}): Pick<HostGovernorCapabilities, "submitAuthenticatedApproval" | "submitApprovalRevocation"> {
  const { state } = params;
  const submitAuthenticatedApproval: HostGovernorCapabilities["submitAuthenticatedApproval"] = (
    input,
  ) => {
    if (!params.isCapability(params.capability)) {
      throw new Error("Governor host approval capability is invalid");
    }
    const id = params.opaqueId(state.key, {
      approval: input,
      nonce: crypto.randomUUID(),
    }) as never;
    const grantId = `ggrant_${crypto.randomUUID()}`;
    const canonicalTargetOpaque = params.targetOpaque(input.canonicalTarget);
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
      grantSignature: params.sign(state.key, grantPayload),
      ...input,
    };
    params.recordGrant({
      grantId,
      scopeKey: input.scopeKey,
      approvalEpoch: input.approvalEpoch,
      observedAt: input.observedAt,
    });
    state.approvals.set(id, Object.freeze({ ...body, signature: params.sign(state.key, body) }));
    return id;
  };

  const submitApprovalRevocation: HostGovernorCapabilities["submitApprovalRevocation"] = (
    input,
  ) => {
    if (!params.isCapability(params.capability)) {
      throw new Error("Governor host approval capability is invalid");
    }
    const id = params.opaqueId(state.key, {
      revocation: input,
      nonce: crypto.randomUUID(),
    }) as never;
    if (!params.revokeGrant(input)) {
      throw new Error("Governor approval revocation was not durably applied");
    }
    const body = { id, ...input };
    state.revocations.set(id, Object.freeze({ ...body, signature: params.sign(state.key, body) }));
    return id;
  };

  return { submitAuthenticatedApproval, submitApprovalRevocation };
}
