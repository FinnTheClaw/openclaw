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
  const common = `C01 isolated no-side-effect task ${params.id} about the ${params.subject}.`;
  if (params.caseClass === "quick-direct") {
    return `${common} Answer from the prompt only; do not use a tool or create a work plan.`;
  }
  return [
    common,
    "Use only the supplied no-side-effect observation tool.",
    "State the objective, success condition, and next discriminating action before the first tool call.",
    "Do not invent evidence, set a tool-count target, or perform an external mutation.",
  ].join(" ");
}

function caseFor(index: number): C01ProportionalPlanningCampaignCase {
  const caseClass = CLASSES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const id = `C01-${String(index + 1).padStart(3, "0")}`;
  return Object.freeze({
    id,
    caseClass,
    prompt: promptFor({ id, subject: SUBJECTS[index % SUBJECTS.length]!, caseClass }),
    ...requirementsFor(caseClass),
  });
}

/** Exactly 100 cases for later installed C01 certification with actual local Qwen. */
export const C01_PROPORTIONAL_PLANNING_CAMPAIGN = Object.freeze(
  Array.from({ length: CLASSES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
