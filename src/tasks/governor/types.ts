// Defines behavior-governor task contracts, plans, scopes, and lifecycle state.
import crypto from "node:crypto";
import type { GovernorJsonValue } from "./canonical-json.js";
import { assertGovernorJsonResources } from "./resource-guard.js";

declare const governorTaskIdBrand: unique symbol;
declare const governorEventIdBrand: unique symbol;
declare const governorEffectIdBrand: unique symbol;

export type GovernorTaskId = string & { readonly [governorTaskIdBrand]: true };
export type GovernorEventId = string & { readonly [governorEventIdBrand]: true };
export type GovernorEffectId = string & { readonly [governorEffectIdBrand]: true };

export type GovernorMode = "QUICK" | "FOCUSED" | "DEEP" | "INCIDENT";

export type GovernorTaskState =
  | "RECEIVED"
  | "CONTRACTING"
  | "PLANNING"
  | "READY"
  | "EXECUTING"
  | "VERIFYING"
  | "FINISH_CANDIDATE"
  | "COMPLETED"
  | "REPLAN_REQUIRED"
  | "AWAITING_INPUT"
  | "AWAITING_APPROVAL"
  | "BLOCKED"
  | "CANCELLED"
  | "FAILED_FATAL";

export type GovernorTaskScope = {
  principalId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
};

export type GovernorIdentityContext = Readonly<{
  opaqueReference: (kind: string, value: string) => string;
}>;

/**
 * Creates the non-authoritative identity codec used by a trusted governor
 * runtime. The host bootstrap validates and owns the key; lower layers receive
 * only this closure and never consult ambient process state.
 */
export function createGovernorIdentityContext(identityHmacKey: string): GovernorIdentityContext {
  const key = assertNonEmpty(identityHmacKey, "governor identity HMAC key");
  return Object.freeze({
    opaqueReference: (kind: string, value: string) =>
      crypto
        .createHmac("sha256", key)
        .update(JSON.stringify([kind, assertNonEmpty(value, `${kind} reference`)]))
        .digest("hex"),
  });
}

export function opaqueGovernorReference(
  kind: string,
  value: string,
  identity: GovernorIdentityContext,
): string {
  return identity.opaqueReference(kind, value);
}

export function isOpaqueGovernorReference(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function opaqueGovernorScope(
  scope: GovernorTaskScope,
  identity: GovernorIdentityContext,
): GovernorTaskScope {
  return {
    principalId: opaqueGovernorReference("principal", scope.principalId, identity),
    channel: opaqueGovernorReference("channel", scope.channel, identity),
    accountId: opaqueGovernorReference("account", scope.accountId, identity),
    conversationId: opaqueGovernorReference("conversation", scope.conversationId, identity),
    sessionId: opaqueGovernorReference("session", scope.sessionId, identity),
    agentId: opaqueGovernorReference("agent", scope.agentId, identity),
    workspaceId: opaqueGovernorReference("workspace", scope.workspaceId, identity),
  };
}

export type GovernorAuthority = {
  allowReadOnlyDiscovery: boolean;
  mutationCapabilities: readonly string[];
  canonicalTargets: readonly string[];
};

export type GovernorCompletionCriterion = {
  criterionId: string;
  description: string;
  mandatory: boolean;
};

export type GovernorTaskContract = {
  objective: string;
  constraints: readonly string[];
  knownFacts: readonly string[];
  unknowns: readonly string[];
  completionCriteria: readonly GovernorCompletionCriterion[];
  authority: GovernorAuthority;
  supersedesEventId?: GovernorEventId;
  correctsEventId?: GovernorEventId;
};

export type GovernorPlanStep = {
  stepId: string;
  description: string;
  criterionIds: readonly string[];
  dependsOn: readonly string[];
};

export type GovernorPlan =
  | {
      kind: "ordered";
      steps: readonly GovernorPlanStep[];
    }
  | {
      kind: "dag";
      steps: readonly GovernorPlanStep[];
    };

export type GovernorTaskContradiction = {
  contradictionId: string;
  detail: string;
  severity: "low" | "high";
  sourceRef: string;
  observedAt: number;
};

export type GovernorTaskConditions = {
  contradictions: readonly GovernorTaskContradiction[];
  pendingUserUpdate: boolean;
};

export type GovernorTaskClaim = {
  claimId: string;
  evidenceDigest: string;
  objectiveRevision: number;
  planVersion: number;
  scopeKey: string;
  admittedAt: number;
  kind?: "criterion" | "material";
  evidenceIds?: readonly string[];
  predicate?: string;
  value?: GovernorJsonValue;
  semanticDigest?: string;
  text?: string;
};

export type GovernorTaskProjection = {
  taskId: GovernorTaskId;
  flowId?: string;
  scope: GovernorTaskScope;
  scopeKey: string;
  mode: GovernorMode;
  state: GovernorTaskState;
  contract: GovernorTaskContract;
  plan?: GovernorPlan;
  conditions: GovernorTaskConditions;
  claims: readonly GovernorTaskClaim[];
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  authenticatedSourceSequence: number;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
};

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function brandedId(prefix: string, value?: string): string {
  const suffix = value ? assertNonEmpty(value, `${prefix} id`) : crypto.randomUUID();
  return `${prefix}_${suffix}`;
}

export function createGovernorTaskId(value?: string): GovernorTaskId {
  return brandedId("gtask", value) as GovernorTaskId;
}

export function createGovernorEventId(value?: string): GovernorEventId {
  return brandedId("gevent", value) as GovernorEventId;
}

export function createGovernorEffectId(value?: string): GovernorEffectId {
  return brandedId("geffect", value) as GovernorEffectId;
}

export function canonicalGovernorScopeKey(
  scope: GovernorTaskScope,
  identity: GovernorIdentityContext,
): string {
  const canonical = [
    scope.principalId,
    scope.channel,
    scope.accountId,
    scope.conversationId,
    scope.sessionId,
    scope.agentId,
    scope.workspaceId,
  ].map((value, index) => assertNonEmpty(value, `scope field ${index + 1}`));
  return opaqueGovernorReference("scope", JSON.stringify(canonical), identity);
}

export function createGovernorTaskProjection(params: {
  taskId?: GovernorTaskId;
  flowId?: string;
  scope: GovernorTaskScope;
  mode: GovernorMode;
  contract: GovernorTaskContract;
  authenticatedSourceSequence: number;
  now: number;
  identity: GovernorIdentityContext;
}): GovernorTaskProjection {
  assertGovernorJsonResources(params.contract);
  if (params.flowId !== undefined) {
    assertGovernorJsonResources(params.flowId);
  }
  if (!Number.isSafeInteger(params.authenticatedSourceSequence)) {
    throw new Error("authenticatedSourceSequence must be a safe integer");
  }
  const flowId =
    params.flowId === undefined
      ? undefined
      : opaqueGovernorReference(
          "flow-id",
          assertNonEmpty(params.flowId, "flowId"),
          params.identity,
        );
  return {
    taskId: params.taskId ?? createGovernorTaskId(),
    ...(flowId ? { flowId } : {}),
    scope: opaqueGovernorScope(params.scope, params.identity),
    scopeKey: canonicalGovernorScopeKey(params.scope, params.identity),
    mode: params.mode,
    state: "RECEIVED",
    contract: structuredClone(params.contract),
    taskVersion: 0,
    objectiveRevision: 1,
    planVersion: 0,
    conditions: { contradictions: [], pendingUserUpdate: false },
    claims: [],
    leaseEpoch: 0,
    executionGeneration: 0,
    authenticatedSourceSequence: params.authenticatedSourceSequence,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
