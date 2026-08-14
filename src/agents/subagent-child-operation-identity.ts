import { createHash } from "node:crypto";

/**
 * One identity contract for a child operation across admission, Gateway
 * receipts, cancellation, and replay. Attempt/run ids remain separate.
 */
export type SubagentChildOperationIdentity = Readonly<{
  controllerSessionKey: string;
  identityKind: "operation" | "canonical";
  identityValue: string;
}>;

export function resolveSubagentChildOperationIdentity(params: {
  controllerSessionKey: string;
  canonicalKey: string;
  operationKey?: string;
}): SubagentChildOperationIdentity {
  const controllerSessionKey = params.controllerSessionKey.trim();
  const operationKey = params.operationKey?.trim();
  const canonicalKey = params.canonicalKey.trim();
  if (!controllerSessionKey || !canonicalKey) {
    throw new Error("child operation identity requires controller and canonical key");
  }
  return {
    controllerSessionKey,
    identityKind: operationKey ? "operation" : "canonical",
    identityValue: operationKey || canonicalKey,
  };
}

export function formatSubagentChildOperationIdentity(
  identity: SubagentChildOperationIdentity,
): string {
  return `${identity.controllerSessionKey}\u0000${identity.identityKind}:${identity.identityValue}`;
}

export function resolveSubagentChildOperationAcceptanceKey(
  identity: SubagentChildOperationIdentity,
): string {
  const digest = createHash("sha256")
    .update(formatSubagentChildOperationIdentity(identity), "utf8")
    .digest("hex");
  return `child_acceptance_${digest}`;
}

export function isSubagentChildOperationIdentityEqual(
  left: SubagentChildOperationIdentity,
  right: SubagentChildOperationIdentity,
): boolean {
  return (
    left.controllerSessionKey === right.controllerSessionKey &&
    left.identityKind === right.identityKind &&
    left.identityValue === right.identityValue
  );
}
