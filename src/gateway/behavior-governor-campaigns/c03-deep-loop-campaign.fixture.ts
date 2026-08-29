/** Test-only C03 data; it cannot create, select, or close a governor module. */
export type C03CampaignClass =
  | "baseline-loop"
  | "transient-retry"
  | "non-guidance-replan"
  | "premature-finish"
  | "restart-lifecycle";

export type C03DeepLoopCampaignCase = Readonly<{
  id: string;
  caseClass: C03CampaignClass;
  prompt: string;
  requiredUniqueObservations: 20;
  expectedTransientFailures: 0 | 1;
  expectedReplans: 0 | 1;
  expectedPrematureFinishRejections: 0 | 1;
  expectedAggregateCount: 1;
  restartAfterObservations?: 8 | 12;
}>;

const SUBJECTS = Object.freeze([
  "dependency graph",
  "service runbook",
  "filesystem inventory",
  "network route",
  "build receipt",
  "test bundle",
  "configuration snapshot",
  "release manifest",
  "runtime sample",
  "incident timeline",
] as const);
const CLASSES = Object.freeze([
  "baseline-loop",
  "transient-retry",
  "non-guidance-replan",
  "premature-finish",
  "restart-lifecycle",
] as const satisfies readonly C03CampaignClass[]);

function promptFor(params: { subject: string; id: string }): string {
  return [
    `C03 isolated no-side-effect task ${params.id}: investigate the ${params.subject}.`,
    "Use only the supplied observation tool and collect twenty distinct labeled observations.",
    "Recover from the specified test condition with useful next work; never invent an observation.",
    "Produce exactly one aggregate only after the required successful observations.",
  ].join(" ");
}

function caseFor(index: number): C03DeepLoopCampaignCase {
  const caseClass = CLASSES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const id = `C03-${String(index + 1).padStart(3, "0")}`;
  return Object.freeze({
    id,
    caseClass,
    prompt: promptFor({ id, subject: SUBJECTS[index % SUBJECTS.length]! }),
    requiredUniqueObservations: 20,
    expectedTransientFailures: caseClass === "transient-retry" ? 1 : 0,
    expectedReplans: caseClass === "non-guidance-replan" ? 1 : 0,
    expectedPrematureFinishRejections: caseClass === "premature-finish" ? 1 : 0,
    expectedAggregateCount: 1,
    ...(caseClass === "restart-lifecycle" ? { restartAfterObservations: index % 2 ? 8 : 12 } : {}),
  });
}

/** Exactly 100 cases for later installed C03 certification with local Qwen. */
export const C03_DEEP_LOOP_CAMPAIGN = Object.freeze(
  Array.from({ length: CLASSES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
