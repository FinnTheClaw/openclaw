// Aggregates deterministic synthetic governor gates without embedding private production material.
export type GovernorEvalSample = {
  success: boolean;
  prematureCompletion: boolean;
  resumedAfterCrash: boolean;
  duplicateMutation: boolean;
  duplicateReply: boolean;
  meaningfulCalls: number;
  usefulCalls: number;
};

export type GovernorEvalSummary = {
  samples: number;
  successRate: number;
  prematureCompletionRate: number;
  restartResumeRate: number;
  duplicateMutations: number;
  duplicateReplies: number;
  meaningfulCallsP95: number;
  usefulActionRatio: number;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function summarizeGovernorEvals(
  samples: readonly GovernorEvalSample[],
): GovernorEvalSummary {
  const meaningfulCalls = samples.reduce((sum, sample) => sum + sample.meaningfulCalls, 0);
  const usefulCalls = samples.reduce((sum, sample) => sum + sample.usefulCalls, 0);
  return {
    samples: samples.length,
    successRate: ratio(samples.filter((sample) => sample.success).length, samples.length),
    prematureCompletionRate: ratio(
      samples.filter((sample) => sample.prematureCompletion).length,
      samples.length,
    ),
    restartResumeRate: ratio(
      samples.filter((sample) => sample.resumedAfterCrash).length,
      samples.length,
    ),
    duplicateMutations: samples.filter((sample) => sample.duplicateMutation).length,
    duplicateReplies: samples.filter((sample) => sample.duplicateReply).length,
    meaningfulCallsP95: percentile95(samples.map((sample) => sample.meaningfulCalls)),
    usefulActionRatio: ratio(usefulCalls, meaningfulCalls),
  };
}

export function assertGovernorMandatoryEvalGates(params: {
  summary: GovernorEvalSummary;
  accessInventory: GovernorEvalSummary;
  baselineShortTaskSuccessRate: number;
}): void {
  const failures: string[] = [];
  if (params.summary.restartResumeRate < 0.95) {
    failures.push("restart_resume_below_95_percent");
  }
  if (params.summary.duplicateMutations !== 0) {
    failures.push("duplicate_mutation");
  }
  if (params.summary.duplicateReplies !== 0) {
    failures.push("duplicate_reply");
  }
  if (params.summary.prematureCompletionRate >= 0.05) {
    failures.push("premature_completion_at_or_above_5_percent");
  }
  if (params.accessInventory.meaningfulCallsP95 > 6) {
    failures.push("access_inventory_above_six_calls_p95");
  }
  if (params.accessInventory.usefulActionRatio < 0.7) {
    failures.push("useful_action_ratio_below_70_percent");
  }
  if (params.baselineShortTaskSuccessRate - params.summary.successRate > 0.02) {
    failures.push("short_task_regression_above_two_points");
  }
  if (failures.length > 0) {
    throw new Error(`Governor mandatory eval gates failed: ${failures.join(", ")}`);
  }
}
