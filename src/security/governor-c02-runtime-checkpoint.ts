import { emitAgentEvent } from "../infra/agent-events.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import { CHECKPOINT_PREFIX } from "./governor-c02-runtime-attestation-model.js";
import type { GovernorC02RestartBinding } from "./governor-c02-runtime-restart.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

export function recordGovernorC02RestartCheckpoint(params: {
  controller: GovernorController;
  taskId: string;
  run: GovernorAgentLoopRunInput;
  systemdInvocationId: string;
  hostDescriptorDigest: string;
  modulePlanDigest: string;
  prepared: GovernorC02PreparedRun;
  binding: GovernorC02RestartBinding;
  toolCallId: string;
  effectId: string;
  resultDigest: string;
  evidenceDigest: string;
  now: number;
}): void {
  const recorded = params.controller.recordCheckpoint({
    taskId: params.taskId as never,
    checkpointId: `c02-restart-${params.taskId}`,
    verifiedFacts: [
      {
        claim: `${CHECKPOINT_PREFIX}${JSON.stringify(params.binding)}`,
        evidenceDigest: governorDigest(params.binding as unknown as GovernorJsonValue),
      },
      { claim: "c02-observe-b-admitted", evidenceDigest: params.evidenceDigest },
    ],
    discardedAssumptions: [],
    unresolvedQuestions: ["gateway restart required"],
    nextDiscriminatingAction: "restart gateway then execute c02-aggregate",
    now: params.now,
  });
  emitAgentEvent({
    runId: params.run.runId,
    stream: "governor_checkpoint",
    sessionKey: params.run.sessionKey,
    sessionId: params.run.sessionId,
    agentId: params.run.agentId,
    data: {
      schema: "openclaw.governor-c02-checkpoint-ready/v1",
      phase: "checkpoint-ready",
      moduleId: C02_SIMPLE_EFFICIENCY_ID,
      moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
      taskId: params.taskId,
      opaqueSessionId: recorded.task.scope.sessionId,
      toolCallId: params.toolCallId,
      effectId: params.effectId,
      toolName: "read",
      criterionId: "c02-observe-b",
      resultDigest: params.resultDigest,
      evidenceDigest: params.evidenceDigest,
      sourceHighwater: recorded.task.authenticatedSourceSequence,
      taskVersion: recorded.task.taskVersion,
      checkpointId: recorded.checkpoint.checkpointId,
      checkpointDigest: governorDigest(recorded.checkpoint as unknown as GovernorJsonValue),
      checkpointCreatedAt: recorded.checkpoint.createdAt,
      gatewayInvocationId: params.run.runId,
      systemdInvocationId: params.systemdInvocationId,
      hostDescriptorDigest: params.hostDescriptorDigest,
      modulePlanDigest: params.modulePlanDigest,
      runBindingDigest: params.prepared.runBindingDigest,
      installedToolDigest: params.prepared.hostToolRegistryDigest,
    },
  });
}
