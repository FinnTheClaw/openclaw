// Defines behavior-governor task contracts, plans, scopes, and lifecycle state.
import crypto from "node:crypto";

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

export type GovernorTaskProjection = {
  taskId: GovernorTaskId;
  flowId?: string;
  scope: GovernorTaskScope;
  scopeKey: string;
  mode: GovernorMode;
  state: GovernorTaskState;
  contract: GovernorTaskContract;
  plan?: GovernorPlan;
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

export function canonicalGovernorScopeKey(scope: GovernorTaskScope): string {
  const canonical = [
    scope.principalId,
    scope.channel,
    scope.accountId,
    scope.conversationId,
    scope.sessionId,
    scope.agentId,
    scope.workspaceId,
  ].map((value, index) => assertNonEmpty(value, `scope field ${index + 1}`));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createGovernorTaskProjection(params: {
  taskId?: GovernorTaskId;
  flowId?: string;
  scope: GovernorTaskScope;
  mode: GovernorMode;
  contract: GovernorTaskContract;
  authenticatedSourceSequence: number;
  now: number;
}): GovernorTaskProjection {
  if (!Number.isSafeInteger(params.authenticatedSourceSequence)) {
    throw new Error("authenticatedSourceSequence must be a safe integer");
  }
  return {
    taskId: params.taskId ?? createGovernorTaskId(),
    ...(params.flowId ? { flowId: assertNonEmpty(params.flowId, "flowId") } : {}),
    scope: structuredClone(params.scope),
    scopeKey: canonicalGovernorScopeKey(params.scope),
    mode: params.mode,
    state: "RECEIVED",
    contract: structuredClone(params.contract),
    taskVersion: 0,
    objectiveRevision: 1,
    planVersion: 0,
    leaseEpoch: 0,
    executionGeneration: 0,
    authenticatedSourceSequence: params.authenticatedSourceSequence,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
