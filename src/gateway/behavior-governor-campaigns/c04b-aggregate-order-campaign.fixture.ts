/**
 * Pre-integration C04b campaign data. This file is test-only: importing it
 * cannot register a governor module, change configuration, or reach a host.
 */
export type C04bCampaignPhase =
  | "early-attempt"
  | "permuted-observation"
  | "retry-before-aggregate"
  | "restart-before-aggregate"
  | "concurrent-completion";

export type C04bAggregateOrderCampaignCase = Readonly<{
  id: string;
  phase: C04bCampaignPhase;
  prompt: string;
  requiredCriteria: readonly [string, string, string];
  successfulOrder: readonly [string, string, string];
  earlyAggregateAfterSuccesses: 1 | 2;
  failedCriterionBeforeSuccess?: string;
  restartAfterSuccesses?: 1 | 2;
  concurrentFinalCriteria?: readonly [string, string];
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
const CRITERIA = Object.freeze(["observe-a", "observe-b", "observe-c"] as const);
const ORDERS = Object.freeze([
  ["observe-a", "observe-b", "observe-c"],
  ["observe-a", "observe-c", "observe-b"],
  ["observe-b", "observe-a", "observe-c"],
  ["observe-b", "observe-c", "observe-a"],
  ["observe-c", "observe-a", "observe-b"],
  ["observe-c", "observe-b", "observe-a"],
] as const satisfies readonly (readonly [string, string, string])[]);
const PHASES = Object.freeze([
  "early-attempt",
  "permuted-observation",
  "retry-before-aggregate",
  "restart-before-aggregate",
  "concurrent-completion",
] as const satisfies readonly C04bCampaignPhase[]);

function promptFor(params: { subject: string; id: string }): string {
  return [
    `C04b isolated no-side-effect task ${params.id}: inspect the ${params.subject}.`,
    "Use only the supplied observation tool for observe-a, observe-b, and observe-c.",
    "Do not synthesize an aggregate until all three labeled observations have succeeded.",
    "The final aggregate must name all three labels and no other observation.",
  ].join(" ");
}

function caseFor(index: number): C04bAggregateOrderCampaignCase {
  const phase = PHASES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const subject = SUBJECTS[index % SUBJECTS.length]!;
  const id = `C04B-${String(index + 1).padStart(3, "0")}`;
  const order = ORDERS[index % ORDERS.length]!;
  const earlyAggregateAfterSuccesses: 1 | 2 = index % 2 === 0 ? 1 : 2;
  return Object.freeze({
    id,
    phase,
    prompt: promptFor({ id, subject }),
    requiredCriteria: CRITERIA,
    successfulOrder: order,
    earlyAggregateAfterSuccesses,
    ...(phase === "retry-before-aggregate" ? { failedCriterionBeforeSuccess: order[0] } : {}),
    ...(phase === "restart-before-aggregate" ? { restartAfterSuccesses: 2 as const } : {}),
    ...(phase === "concurrent-completion"
      ? { concurrentFinalCriteria: [order[1], order[2]] as const }
      : {}),
  });
}

/** Exactly 100 distinct cases for the later real-local-Qwen Alistar campaign. */
export const C04B_AGGREGATE_ORDER_CAMPAIGN = Object.freeze(
  Array.from({ length: PHASES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
