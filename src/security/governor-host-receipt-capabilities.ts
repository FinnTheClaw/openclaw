import crypto from "node:crypto";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  HostBrokerState,
  HostGovernorCapabilities,
  HostGovernorEvidenceInvalidationReceiptId,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";
import { assertGovernorEvidenceInvalidationProvenance } from "./governor-host-evidence-invalidation-provenance.js";

export function createHostReceiptCapabilities(params: {
  state: HostBrokerState;
  capability: object;
  isCapability: (value: object) => boolean;
  sign: (key: string, value: GovernorJsonValue) => string;
  opaqueId: (key: string, value: GovernorJsonValue) => string;
}): Pick<HostGovernorCapabilities, "submitObservedReceipt" | "submitEvidenceInvalidation"> {
  const { state } = params;
  const submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"] = (input) => {
    if (!params.isCapability(params.capability)) {
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
    const id = params.opaqueId(state.key, {
      ...body,
      nonce: crypto.randomUUID(),
    }) as HostGovernorReceiptId;
    const receipt = Object.freeze({
      id,
      ...input,
      signature: params.sign(state.key, { id, ...body }),
    });
    state.receipts.set(id, receipt);
    return id;
  };

  const submitEvidenceInvalidation: HostGovernorCapabilities["submitEvidenceInvalidation"] = (
    input,
  ) => {
    if (!params.isCapability(params.capability)) {
      throw new Error("Governor host evidence invalidation capability is invalid");
    }
    if (!Number.isSafeInteger(input.taskVersion) || input.taskVersion < 0) {
      throw new Error("Governor evidence invalidation envelope is invalid");
    }
    if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
      throw new Error("Governor evidence invalidation timestamp is invalid");
    }
    assertGovernorEvidenceInvalidationProvenance(
      input.reasonCode,
      input.provenance,
      input.scopeKey,
      input.observedAt,
    );
    const id = params.opaqueId(state.key, {
      evidenceInvalidation: input,
      nonce: crypto.randomUUID(),
    }) as HostGovernorEvidenceInvalidationReceiptId;
    const body = {
      id,
      ...input,
      provenanceDigest: governorDigest(input.provenance),
    };
    const receipt = Object.freeze({ ...body, signature: params.sign(state.key, body) });
    state.evidenceInvalidations.set(id, receipt);
    return id;
  };

  return { submitObservedReceipt, submitEvidenceInvalidation };
}
