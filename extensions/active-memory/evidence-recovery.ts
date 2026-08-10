import crypto from "node:crypto";

export const DEFAULT_RECALL_TOOL_CALL_BUDGET = 4;
export const MIN_RECALL_TOOL_CALL_BUDGET = 3;
export const MAX_RECALL_TOOL_CALL_BUDGET = 6;

export type EvidenceRecoveryTerminationReason =
  | "completed"
  | "no_relevant_memory"
  | "unchanged_evidence"
  | "repeated_unavailable_or_empty"
  | "hard_budget"
  | "unavailable"
  | "failed";

export type EvidenceRecoveryReceipt = {
  callsUsed: number;
  progressTransitions: number;
  terminationReason: EvidenceRecoveryTerminationReason;
  unmetAcceptanceCriteria: string[];
  unsupportedClaims: string[];
  contradictions: string[];
  semanticFailures: string[];
  missingEvidence: string[];
};

export type EvidenceRecoveryObservation = {
  toolName: string;
  result: unknown;
  isError: boolean;
  hasUsableEvidence: boolean;
  isUnavailable: boolean;
};

const USABLE_EVIDENCE_CRITERION =
  "A memory tool must return usable evidence relevant to the bounded search query.";
const FINAL_REPLY_CRITERION = "The sidecar must finalize with one compact memory note or NONE.";

const VOLATILE_EVIDENCE_KEYS = new Set([
  "completedat",
  "createdat",
  "durationms",
  "elapsedms",
  "latencyms",
  "observedat",
  "requestid",
  "runid",
  "startedat",
  "timestamp",
  "toolcallid",
  "traceid",
  "updatedat",
]);

function isVolatileEvidenceKey(key: string): boolean {
  return VOLATILE_EVIDENCE_KEYS.has(key.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase());
}

function canonicalizeForDigest(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= 8) {
    return "[depth-limit]";
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.slice(0, 8192);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[cycle]";
    }
    seen.add(value);
    return value.slice(0, 256).map((entry) => canonicalizeForDigest(entry, depth + 1, seen));
  }
  if (typeof value !== "object") {
    return value === undefined ? "[undefined]" : "[unsupported]";
  }
  if (seen.has(value)) {
    return "[cycle]";
  }
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isVolatileEvidenceKey(key))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .slice(0, 256);
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, canonicalizeForDigest(entry, depth + 1, seen)]),
  );
}

function digestObservation(observation: EvidenceRecoveryObservation): string {
  const canonical = canonicalizeForDigest({
    isError: observation.isError,
    isUnavailable: observation.isUnavailable,
    result: observation.result,
  });
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class EvidenceRecoveryTracker {
  readonly toolCallBudget: number;
  private callsUsed = 0;
  private progressTransitions = 0;
  private lastDigest: string | undefined;
  private lastToolName: string | undefined;
  private emptyOrUnavailableStreak = 0;
  private terminationReason: EvidenceRecoveryTerminationReason | undefined;
  private readonly semanticFailures: string[] = [];
  private readonly missingEvidence: string[] = [];

  constructor(toolCallBudget: number) {
    if (
      !Number.isInteger(toolCallBudget) ||
      toolCallBudget < MIN_RECALL_TOOL_CALL_BUDGET ||
      toolCallBudget > MAX_RECALL_TOOL_CALL_BUDGET
    ) {
      throw new RangeError(
        `Active Memory tool-call budget must be an integer from ${MIN_RECALL_TOOL_CALL_BUDGET} through ${MAX_RECALL_TOOL_CALL_BUDGET}.`,
      );
    }
    this.toolCallBudget = toolCallBudget;
  }

  observe(observation: EvidenceRecoveryObservation): EvidenceRecoveryTerminationReason | undefined {
    if (this.terminationReason) {
      return this.terminationReason;
    }

    this.callsUsed += 1;
    const digest = digestObservation(observation);
    const unchangedResult = this.lastDigest === digest;
    const changedStrategy =
      this.lastToolName !== undefined && this.lastToolName !== observation.toolName;

    if (this.lastDigest !== undefined && !unchangedResult) {
      this.progressTransitions += 1;
    }

    if (observation.isError) {
      this.semanticFailures.push(`Memory tool ${observation.toolName} returned an error.`);
    }
    if (observation.isUnavailable) {
      this.semanticFailures.push(`Memory tool ${observation.toolName} reported unavailable.`);
    }

    if (observation.hasUsableEvidence) {
      this.emptyOrUnavailableStreak = 0;
    } else {
      this.emptyOrUnavailableStreak += 1;
      this.missingEvidence.push(`Memory tool ${observation.toolName} returned no usable evidence.`);
    }

    this.lastDigest = digest;
    this.lastToolName = observation.toolName;

    // A reattempt must add discriminating evidence or change strategy. Repeating
    // the same tool and result is terminal even when call budget remains.
    if (unchangedResult && !changedStrategy) {
      this.terminationReason = "unchanged_evidence";
    } else if (this.emptyOrUnavailableStreak >= 2) {
      this.terminationReason = "repeated_unavailable_or_empty";
    } else if (this.callsUsed >= this.toolCallBudget) {
      this.terminationReason = "hard_budget";
    }
    return this.terminationReason;
  }

  finalize(params: {
    hasUsableEvidence: boolean;
    hasFinalSummary: boolean;
    noReply: boolean;
    failed?: boolean;
    unavailable?: boolean;
    unsupportedClaims?: readonly string[];
    contradictions?: readonly string[];
    semanticFailures?: readonly string[];
    missingEvidence?: readonly string[];
  }): EvidenceRecoveryReceipt {
    const explicitUnsupportedClaims = unique(params.unsupportedClaims ?? []);
    const explicitContradictions = unique(params.contradictions ?? []);
    const explicitSemanticFailures = unique(params.semanticFailures ?? []);
    const hasExplicitBlocker =
      explicitUnsupportedClaims.length > 0 ||
      explicitContradictions.length > 0 ||
      explicitSemanticFailures.length > 0;
    const completedAtBudget =
      this.terminationReason === "hard_budget" &&
      !params.failed &&
      !params.unavailable &&
      !params.noReply &&
      !hasExplicitBlocker &&
      params.hasUsableEvidence &&
      params.hasFinalSummary;
    const terminationReason =
      (completedAtBudget ? "completed" : this.terminationReason) ??
      (params.failed || hasExplicitBlocker
        ? "failed"
        : params.unavailable
          ? "unavailable"
          : params.noReply
            ? "no_relevant_memory"
            : params.hasUsableEvidence && params.hasFinalSummary
              ? "completed"
              : "failed");
    const unmetAcceptanceCriteria: string[] = [];
    if (
      !params.hasUsableEvidence &&
      terminationReason !== "no_relevant_memory" &&
      terminationReason !== "completed"
    ) {
      unmetAcceptanceCriteria.push(USABLE_EVIDENCE_CRITERION);
    }
    if (params.hasUsableEvidence && !params.hasFinalSummary && !params.noReply) {
      unmetAcceptanceCriteria.push(FINAL_REPLY_CRITERION);
    }
    if (explicitUnsupportedClaims.length > 0) {
      unmetAcceptanceCriteria.push("Every unsupported claim must be removed or supported by evidence.");
    }
    if (explicitContradictions.length > 0) {
      unmetAcceptanceCriteria.push("Every contradiction must be resolved against current evidence.");
    }
    if (explicitSemanticFailures.length > 0) {
      unmetAcceptanceCriteria.push("Every semantic failure must reach a typed successful postcondition.");
    }
    return {
      callsUsed: this.callsUsed,
      progressTransitions: this.progressTransitions,
      terminationReason,
      unmetAcceptanceCriteria,
      unsupportedClaims: explicitUnsupportedClaims,
      contradictions: explicitContradictions,
      semanticFailures: unique([...this.semanticFailures, ...explicitSemanticFailures]),
      missingEvidence: unique([...this.missingEvidence, ...(params.missingEvidence ?? [])]),
    };
  }
}
