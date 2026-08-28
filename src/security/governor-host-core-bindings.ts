/** Narrow production binding for the governed embedded-agent loop. */
import crypto from "node:crypto";
import { canonicalGovernorJson, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  GovernorTrustedEvidenceInvalidationResolver,
  GovernorTrustedReceiptResolver,
  HostGovernorCoreState,
  HostGovernorReceiptId,
} from "./governor-host-contracts.js";
import { createHostGovernorCoreResolvers } from "./governor-host-core-resolvers.js";
import { createHostReceiptCapabilities } from "./governor-host-receipt-capabilities.js";
import { isGovernorSecrets, type GovernorSecrets } from "./governor-host-secrets.js";

const CAPABILITIES = new WeakSet<object>();

function sign(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: GovernorJsonValue): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

export type GovernorAgentLoopCoreBindings = Readonly<{
  submitObservedReceipt: (input: {
    scopeKey: string;
    taskId: string;
    taskVersion: number;
    objectiveRevision: number;
    planVersion: number;
    sourceKind: "tool" | "structured_external" | "authenticated_user";
    sourceIdentity: string;
    payload: GovernorJsonValue;
    observedAt: number;
  }) => HostGovernorReceiptId;
  submitEvidenceInvalidation: ReturnType<
    typeof createHostReceiptCapabilities
  >["submitEvidenceInvalidation"];
  receiptResolver: GovernorTrustedReceiptResolver;
  evidenceInvalidationResolver: GovernorTrustedEvidenceInvalidationResolver;
  close: () => void;
}>;

/**
 * Intentionally contains only receipt/evidence admission state. Channel, owner,
 * delivery, approval, physical, memory, and task authority are not dependencies.
 */
export function createGovernorAgentLoopCoreBindings(params: {
  secrets: GovernorSecrets;
  state?: HostGovernorCoreState;
}): GovernorAgentLoopCoreBindings {
  if (!isGovernorSecrets(params.secrets)) {
    throw new Error("GOVERNOR_CORE_SECRETS_REQUIRED");
  }
  const state =
    params.state ??
    ({
      key: params.secrets.receiptSigningKey,
      receipts: new Map(),
      evidenceInvalidations: new Map(),
    } satisfies HostGovernorCoreState);
  const capability = {};
  CAPABILITIES.add(capability);
  let closed = false;
  const assertOpen = () => {
    if (closed) {
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
  const { resolver: receiptResolver, evidenceInvalidationResolver } =
    createHostGovernorCoreResolvers({
      state,
      assertOpen,
      sign,
    });
  return Object.freeze({
    submitObservedReceipt: (input) => {
      assertOpen();
      return submitObservedReceipt(input);
    },
    submitEvidenceInvalidation: (input) => {
      assertOpen();
      return submitEvidenceInvalidation(input);
    },
    receiptResolver,
    evidenceInvalidationResolver,
    close: () => {
      closed = true;
    },
  });
}
