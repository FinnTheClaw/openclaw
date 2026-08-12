import type { GovernorJsonValue } from "./canonical-json.js";
import type { GovernorEffectId, GovernorTaskId } from "./types.js";

export type GovernorSemanticOutcome =
  | "success"
  | "not_found"
  | "ambiguous"
  | "partial"
  | "denied"
  | "transient_failure"
  | "permanent_failure"
  | "cancelled";

export type GovernorToolOutcome = {
  transport: "completed" | "failed" | "unknown";
  semantic: GovernorSemanticOutcome;
  sideEffect: "not_applicable" | "none" | "applied" | "unknown";
  verification: "not_required" | "required" | "verified" | "failed";
  summaryCode: string;
  evidence?: GovernorJsonValue;
};

export type GovernorActionProposal = {
  taskId: GovernorTaskId;
  effectId: GovernorEffectId;
  criterionId?: string;
  capability: string;
  capabilityVersion: string;
  canonicalTarget: string;
  expectedEvidence: string;
  sourceRank: "structured_exact" | "scoped_index" | "targeted_search" | "broad_scan";
  stopCondition: string;
  mutating: boolean;
  argumentsDigest: string;
  /** Host-owned identity of the exact resolved tool implementation. */
  toolImplementationDigest?: string;
  approvalGrantId?: string;
};

export type GovernorEffectRecord = GovernorActionProposal & {
  idempotencyKey: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  actionFingerprint: string;
  progressVectorHash: string;
  outcome: GovernorToolOutcome;
  verificationState: GovernorToolOutcome["verification"];
  reconcileRequired: boolean;
  createdAt: number;
  updatedAt: number;
};
