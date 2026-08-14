import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeChildAdmission,
  AgentRuntimeIdentity,
} from "../gateway/agent-runtime-identity-token.js";
import type { SubagentChildOperationIdentity } from "./subagent-child-operation-identity.js";

const CHILD_CAPABILITY_TTL_MS = 60_000;

export function buildSubagentChildAdmissionCapability(params: {
  agentId: string;
  childSessionKey: string;
  identity: SubagentChildOperationIdentity;
  requestDigest: string;
  resolvedDigest: string;
  gatewayGeneration: string;
  now?: number;
}): AgentRuntimeIdentity {
  const now = params.now ?? Date.now();
  const childAdmission: AgentRuntimeChildAdmission = Object.freeze({
    controllerSessionKey: params.identity.controllerSessionKey,
    identityKind: params.identity.identityKind,
    identityValue: params.identity.identityValue,
    requestDigest: params.requestDigest,
    resolvedDigest: params.resolvedDigest,
    targetAgentId: params.agentId,
    gatewayGeneration: params.gatewayGeneration,
    expiresAtMs: now + CHILD_CAPABILITY_TTL_MS,
    nonce: randomUUID(),
  });
  return Object.freeze({
    kind: "agentRuntime" as const,
    agentId: params.agentId,
    sessionKey: params.childSessionKey,
    childAdmission,
  });
}

export function isSubagentChildAdmissionCapabilityValid(params: {
  identity: AgentRuntimeIdentity | undefined;
  expected: {
    agentId: string;
    childSessionKey: string;
    identity: SubagentChildOperationIdentity;
    requestDigest: string;
    resolvedDigest: string;
    gatewayGeneration: string;
    now?: number;
  };
}): boolean {
  const admission = params.identity?.childAdmission;
  if (!admission) {
    return false;
  }
  const now = params.expected.now ?? Date.now();
  return (
    params.identity?.agentId === params.expected.agentId &&
    params.identity?.sessionKey === params.expected.childSessionKey &&
    admission.controllerSessionKey === params.expected.identity.controllerSessionKey &&
    admission.identityKind === params.expected.identity.identityKind &&
    admission.identityValue === params.expected.identity.identityValue &&
    admission.requestDigest === params.expected.requestDigest &&
    admission.resolvedDigest === params.expected.resolvedDigest &&
    admission.targetAgentId === params.expected.agentId &&
    admission.gatewayGeneration === params.expected.gatewayGeneration &&
    admission.nonce.length >= 32 &&
    admission.expiresAtMs >= now
  );
}
