import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";

type GuidanceRecoveryParams = {
  controller: GovernorController;
  taskId: GovernorTaskId;
  progressDigest: string;
  now: number;
};

function isGuidanceEvent(event: { eventType: string; payload: unknown }, progressDigest: string) {
  const payload = event.payload;
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  return (
    event.eventType === "runtime_replan_requested" &&
    record?.guidanceOnly === true &&
    record.progressDigest === progressDigest
  );
}

/** Reconstructs one durable tool-failure guidance event without re-guiding handled failures. */
export function recoverGovernorAgentLoopGuidance(params: GuidanceRecoveryParams): boolean {
  const runtimeEvents = params.controller.store.listEvents(params.taskId);
  const handledFailureEffects = new Set(
    runtimeEvents
      .filter((event) => event.eventType === "runtime_replan_requested")
      .flatMap((event) => {
        const payload = event.payload;
        return typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          typeof payload.sourceEffectId === "string"
          ? [payload.sourceEffectId]
          : [];
      }),
  );
  if (runtimeEvents.toReversed().some((event) => isGuidanceEvent(event, params.progressDigest))) {
    return true;
  }
  const failedEffect = params.controller.store
    .listCurrentEffects(params.taskId)
    .toReversed()
    .find(
      (effect) =>
        effect.outcome.semantic === "transient_failure" &&
        !handledFailureEffects.has(effect.effectId),
    );
  if (!failedEffect) {
    return false;
  }
  params.controller.recordRuntimeReplanGuidance(params.taskId, params.now + 1, {
    reasonCode: "tool_semantic_failure",
    progressDigest: params.progressDigest,
    sourceEffectId: failedEffect.effectId,
  });
  return params.controller.store
    .listEvents(params.taskId)
    .toReversed()
    .some((event) => isGuidanceEvent(event, params.progressDigest));
}
