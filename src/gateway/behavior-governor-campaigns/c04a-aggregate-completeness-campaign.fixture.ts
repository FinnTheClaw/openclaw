/** Test-only C04a data; it neither imports a module nor touches a governor host. */
export type C04aCampaignClass =
  | "exact-map"
  | "duplicate-required"
  | "extra-known-optional"
  | "stale-or-inadmissible"
  | "restart-or-concurrency";

export type C04aAggregateCompletenessCampaignCase = Readonly<{
  id: string;
  caseClass: C04aCampaignClass;
  prompt: string;
  requiredCriteria: readonly [string, string, string];
  evidenceCriterionIds: readonly string[];
  expectedDecision: "accept" | "reject";
  expectedReason?: "duplicate" | "extra" | "stale";
  staleDimension?: "objective" | "plan" | "scope" | "admissibility" | "invalidation";
}>;

const SUBJECTS = Object.freeze([
  "dependency manifest",
  "service status record",
  "filesystem inventory",
  "network route note",
  "build receipt",
  "test result bundle",
  "configuration snapshot",
  "release manifest",
  "runtime health sample",
  "incident timeline",
] as const);
const REQUIRED = Object.freeze(["observe-a", "observe-b", "observe-c"] as const);
const CLASSES = Object.freeze([
  "exact-map",
  "duplicate-required",
  "extra-known-optional",
  "stale-or-inadmissible",
  "restart-or-concurrency",
] as const satisfies readonly C04aCampaignClass[]);
const STALE_DIMENSIONS = Object.freeze([
  "objective",
  "plan",
  "scope",
  "admissibility",
  "invalidation",
] as const satisfies readonly NonNullable<
  C04aAggregateCompletenessCampaignCase["staleDimension"]
>[]);

function promptFor(params: { subject: string; id: string }): string {
  return [
    `C04a isolated no-side-effect task ${params.id}: inspect the ${params.subject}.`,
    "Use only the supplied observation tool for observe-a, observe-b, and observe-c.",
    "A final aggregate is valid only for one current evidence record per required label.",
    "Do not claim optional observations as required evidence.",
  ].join(" ");
}

function evidenceFor(caseClass: C04aCampaignClass): readonly string[] {
  if (caseClass === "duplicate-required")
    return ["observe-a", "observe-b", "observe-b", "observe-c"];
  if (caseClass === "extra-known-optional") return [...REQUIRED, "observe-optional"];
  return REQUIRED;
}

function caseFor(index: number): C04aAggregateCompletenessCampaignCase {
  const caseClass = CLASSES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const id = `C04A-${String(index + 1).padStart(3, "0")}`;
  const expectedDecision =
    caseClass === "exact-map" || caseClass === "restart-or-concurrency" ? "accept" : "reject";
  const expectedReason =
    caseClass === "duplicate-required"
      ? "duplicate"
      : caseClass === "extra-known-optional"
        ? "extra"
        : caseClass === "stale-or-inadmissible"
          ? "stale"
          : undefined;
  return Object.freeze({
    id,
    caseClass,
    prompt: promptFor({ id, subject: SUBJECTS[index % SUBJECTS.length]! }),
    requiredCriteria: REQUIRED,
    evidenceCriterionIds: evidenceFor(caseClass),
    expectedDecision,
    ...(expectedReason ? { expectedReason } : {}),
    ...(caseClass === "stale-or-inadmissible"
      ? { staleDimension: STALE_DIMENSIONS[index % STALE_DIMENSIONS.length]! }
      : {}),
  });
}

/** Exactly 100 distinct cases for later installed, local-Qwen C04a certification. */
export const C04A_AGGREGATE_COMPLETENESS_CAMPAIGN = Object.freeze(
  Array.from({ length: CLASSES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
