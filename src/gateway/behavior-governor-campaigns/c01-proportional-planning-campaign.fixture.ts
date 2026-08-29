/** Test-only C01 data; it cannot create, select, or activate a governor module. */
export type C01CampaignClass =
  | "quick-direct"
  | "focused-readonly"
  | "focused-effectful"
  | "deep-action-estimate"
  | "deep-branch-estimate";

export type C01ProportionalPlanningCampaignCase = Readonly<{
  id: string;
  caseClass: C01CampaignClass;
  prompt: string;
  expectedMode: "QUICK" | "FOCUSED" | "DEEP";
  requiresPlan: boolean;
  expectedToolPolicy: "forbidden" | "required";
  estimatedUsefulActions: 0 | 1 | 13;
  independentBranches: 0 | 1 | 4;
  requiredSubactions?: readonly string[];
  requiredBranchNames?: readonly string[];
  simulatedActionTarget?: string;
}>;

const SUBJECTS = Object.freeze([
  "dependency receipt",
  "service inventory",
  "filesystem fact",
  "network endpoint",
  "build record",
  "test observation",
  "configuration value",
  "release fact",
  "runtime sample",
  "incident symptom",
] as const);

const CLASSES = Object.freeze([
  "quick-direct",
  "focused-readonly",
  "focused-effectful",
  "deep-action-estimate",
  "deep-branch-estimate",
] as const satisfies readonly C01CampaignClass[]);

export const C01_DEEP_SUBACTIONS = Object.freeze([
  "identity",
  "origin",
  "freshness",
  "scope",
  "owner",
  "format",
  "dependency",
  "current-state",
  "expected-state",
  "evidence-source",
  "conflict-status",
  "verification",
  "conclusion",
] as const);

export const C01_DEEP_BRANCHES = Object.freeze([
  "configuration",
  "runtime",
  "receipt",
  "rollback",
] as const);

function requirementsFor(caseClass: C01CampaignClass) {
  switch (caseClass) {
    case "quick-direct":
      return {
        expectedMode: "QUICK" as const,
        requiresPlan: false,
        expectedToolPolicy: "forbidden" as const,
        estimatedUsefulActions: 0 as const,
        independentBranches: 0 as const,
      };
    case "focused-readonly":
      return {
        expectedMode: "FOCUSED" as const,
        requiresPlan: true,
        expectedToolPolicy: "required" as const,
        estimatedUsefulActions: 1 as const,
        independentBranches: 0 as const,
      };
    case "focused-effectful":
      return {
        expectedMode: "FOCUSED" as const,
        requiresPlan: true,
        expectedToolPolicy: "required" as const,
        estimatedUsefulActions: 1 as const,
        independentBranches: 1 as const,
      };
    case "deep-action-estimate":
      return {
        expectedMode: "DEEP" as const,
        requiresPlan: true,
        expectedToolPolicy: "required" as const,
        estimatedUsefulActions: 13 as const,
        independentBranches: 0 as const,
      };
    case "deep-branch-estimate":
      return {
        expectedMode: "DEEP" as const,
        requiresPlan: true,
        expectedToolPolicy: "required" as const,
        estimatedUsefulActions: 1 as const,
        independentBranches: 4 as const,
      };
  }
}

function promptFor(params: { id: string; subject: string; caseClass: C01CampaignClass }): string {
  const common = `C01 isolated test task ${params.id} about the ${params.subject}.`;
  switch (params.caseClass) {
    case "quick-direct":
      return `${common} The supplied fact is current and complete: status is ready. Answer from this prompt only.`;
    case "focused-readonly":
      return [
        common,
        "The current value is not supplied.",
        "Read it from the provided no-side-effect observation tool and report only evidence returned there.",
      ].join(" ");
    case "focused-effectful":
      return [
        common,
        "Execute this simulated action contract: change field status to verified in the disposable in-memory test record, then read that record to verify the postcondition.",
        "The simulation tool cannot affect the host, network, filesystem, or any external system.",
      ].join(" ");
    case "deep-action-estimate":
      return [
        common,
        `Resolve all thirteen required results independently: ${C01_DEEP_SUBACTIONS.join(", ")}.`,
        "Use the provided no-side-effect observation tool as needed, retain evidence for every result, then synthesize one conclusion.",
      ].join(" ");
    case "deep-branch-estimate":
      return [
        common,
        `Investigate four independent branches: ${C01_DEEP_BRANCHES.join(", ")}.`,
        "Use the provided no-side-effect observation tool, preserve evidence per branch, and reconcile the branch findings into one answer.",
      ].join(" ");
  }
}

function caseFor(index: number): C01ProportionalPlanningCampaignCase {
  const caseClass = CLASSES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const id = `C01-${String(index + 1).padStart(3, "0")}`;
  return Object.freeze({
    id,
    caseClass,
    prompt: promptFor({ id, subject: SUBJECTS[index % SUBJECTS.length]!, caseClass }),
    ...requirementsFor(caseClass),
    ...(caseClass === "deep-action-estimate" ? { requiredSubactions: C01_DEEP_SUBACTIONS } : {}),
    ...(caseClass === "deep-branch-estimate" ? { requiredBranchNames: C01_DEEP_BRANCHES } : {}),
    ...(caseClass === "focused-effectful" ? { simulatedActionTarget: "status=verified" } : {}),
  });
}

/** Exactly 100 cases for later installed C01 certification with actual local Qwen. */
export const C01_PROPORTIONAL_PLANNING_CAMPAIGN = Object.freeze(
  Array.from({ length: CLASSES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
