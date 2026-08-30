import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorSqliteStore } from "../tasks/governor/store.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import {
  CHECKPOINT_PREFIX,
  type GovernorC02StoreSnapshot,
  dataRecord,
  exactKeys,
  fail,
} from "./governor-c02-runtime-attestation-model.js";
import {
  C02_CRITERIA_TEMPLATE,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

function expectedPlan(): GovernorJsonValue {
  const steps = new Map<string, string>(
    C02_CRITERIA_TEMPLATE.map((criterion, index) => [
      criterion.criterionId,
      `runtime-step-${index + 1}`,
    ]),
  );
  return {
    kind: "dag",
    steps: C02_CRITERIA_TEMPLATE.map((criterion, index) => ({
      stepId: `runtime-step-${index + 1}`,
      description: `Satisfy ${criterion.criterionId}`,
      criterionIds: [criterion.criterionId],
      dependsOn: criterion.dependsOn.map((item) => steps.get(item)!),
    })),
  };
}

export type GovernorC02RestartBinding = Readonly<{
  taskId: string;
  sessionId: string;
  systemdInvocationId: string;
  gatewayInvocationId: string;
  hostDescriptorDigest: string;
  modulePlanDigest: string;
  installedToolDigest: string;
  sourceHighwater: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
}>;

const BINDING_KEYS = [
  "taskId",
  "sessionId",
  "systemdInvocationId",
  "gatewayInvocationId",
  "hostDescriptorDigest",
  "modulePlanDigest",
  "installedToolDigest",
  "sourceHighwater",
  "taskVersion",
  "objectiveRevision",
  "planVersion",
  "executionGeneration",
] as const;

export function parseGovernorC02RestartBinding(claim: string): GovernorC02RestartBinding {
  try {
    const parsed = dataRecord(JSON.parse(claim.slice(CHECKPOINT_PREFIX.length)));
    if (
      !parsed ||
      !exactKeys(parsed, BINDING_KEYS) ||
      BINDING_KEYS.slice(0, 7).some(
        (key) => typeof parsed[key] !== "string" || !(parsed[key] as string).trim(),
      ) ||
      BINDING_KEYS.slice(7).some(
        (key) => !Number.isSafeInteger(parsed[key]) || (parsed[key] as number) < 0,
      )
    ) {
      fail();
    }
    return Object.freeze(parsed) as unknown as GovernorC02RestartBinding;
  } catch {
    fail();
  }
}

export function validateGovernorC02RestartSnapshot(params: {
  store: GovernorSqliteStore;
  run: GovernorAgentLoopRunInput;
  prepared: GovernorC02PreparedRun;
  modulePlanDigest: string;
  initialGatewayInvocationId: string;
  systemdInvocationId: string;
  snapshot: GovernorC02StoreSnapshot;
  phase: "pre-aggregate" | "terminal";
}): GovernorC02RestartBinding {
  const { task, highwater, events, intents, effects, evidence, checkpoints } = params.snapshot;
  const checkpoint = checkpoints[0];
  const bindingFacts = checkpoint?.verifiedFacts.filter((fact) =>
    fact.claim.startsWith(CHECKPOINT_PREFIX),
  );
  const observeFacts = checkpoint?.verifiedFacts.filter(
    (fact) => fact.claim === "c02-observe-b-admitted",
  );
  if (
    checkpoints.length !== 1 ||
    !checkpoint ||
    bindingFacts?.length !== 1 ||
    observeFacts?.length !== 1 ||
    checkpoint.verifiedFacts.length !== 2
  ) {
    fail();
  }
  const bindingFact = bindingFacts[0]!;
  const observeFact = observeFacts[0]!;
  const binding = parseGovernorC02RestartBinding(bindingFact.claim);
  const expectedActionCount = params.phase === "pre-aggregate" ? 2 : 3;
  const turns = events.filter((event) => {
    const payload = dataRecord(event.payload);
    return (
      event.eventType === "runtime_model_turn_recorded" &&
      payload?.executionGeneration === task.executionGeneration
    );
  });
  const expectedSourceMessage = params.store.opaqueReference(
    `source-message:${task.scopeKey}`,
    params.run.sourceMessageId,
  );
  if (
    intents.length !== expectedActionCount ||
    effects.length !== expectedActionCount ||
    evidence.length !== expectedActionCount ||
    turns.length !== (params.phase === "pre-aggregate" ? 2 : 4) ||
    task.flowId !== params.store.opaqueReference("flow-id", params.initialGatewayInvocationId) ||
    task.scope.sessionId !== params.store.opaqueReference("session", params.run.sessionId) ||
    highwater.taskId !== task.taskId ||
    highwater.sourceSequence !== task.authenticatedSourceSequence ||
    highwater.sourceMessageRef !== expectedSourceMessage ||
    (params.run.sourceSequence !== undefined &&
      highwater.sourceSequence !== params.run.sourceSequence) ||
    highwater.updatedAt > task.updatedAt ||
    task.contract.completionCriteria.length !== C02_CRITERIA_TEMPLATE.length ||
    task.contract.completionCriteria.some((criterion, index) => {
      const expected = C02_CRITERIA_TEMPLATE[index];
      return (
        !expected ||
        criterion.criterionId !== expected.criterionId ||
        criterion.mandatory !== true ||
        governorDigest((criterion.dependsOnCriteria ?? []) as unknown as GovernorJsonValue) !==
          governorDigest(expected.dependsOn as unknown as GovernorJsonValue)
      );
    }) ||
    !task.plan ||
    governorDigest(task.plan as unknown as GovernorJsonValue) !== governorDigest(expectedPlan()) ||
    checkpoint.checkpointId !== `c02-restart-${task.taskId}` ||
    checkpoint.taskId !== task.taskId ||
    checkpoint.objectiveRevision !== task.objectiveRevision ||
    checkpoint.planVersion !== task.planVersion ||
    checkpoint.taskVersion !== binding.taskVersion ||
    checkpoint.taskVersion > task.taskVersion ||
    checkpoint.discardedAssumptions.length !== 0 ||
    checkpoint.unresolvedQuestions.length !== 1 ||
    checkpoint.unresolvedQuestions[0] !== "gateway restart required" ||
    checkpoint.nextDiscriminatingAction !== "restart gateway then execute c02-aggregate" ||
    checkpoint.competingHypotheses.length !== 0 ||
    binding.taskId !== task.taskId ||
    binding.sessionId !== params.run.sessionId ||
    binding.systemdInvocationId === params.systemdInvocationId ||
    binding.gatewayInvocationId !== params.initialGatewayInvocationId ||
    binding.gatewayInvocationId === params.run.runId ||
    binding.hostDescriptorDigest !== params.prepared.hostDescriptorDigest ||
    binding.modulePlanDigest !== params.modulePlanDigest ||
    binding.installedToolDigest !== params.prepared.hostToolRegistryDigest ||
    binding.sourceHighwater !== highwater.sourceSequence ||
    binding.objectiveRevision !== task.objectiveRevision ||
    binding.planVersion !== task.planVersion ||
    binding.executionGeneration !== task.executionGeneration ||
    bindingFact.evidenceDigest !== governorDigest(binding as unknown as GovernorJsonValue) ||
    observeFact.evidenceDigest !== evidence[1]?.evidenceDigest ||
    checkpoint.createdAt <= (evidence[1]?.observedAt ?? Number.MAX_SAFE_INTEGER) ||
    (params.phase === "pre-aggregate" &&
      (task.state === "COMPLETED" || intents[2] !== undefined || effects[2] !== undefined)) ||
    (params.phase === "terminal" && checkpoint.createdAt >= (intents[2]?.createdAt ?? -1))
  ) {
    fail();
  }
  for (let index = 0; index < Math.min(expectedActionCount, 2); index += 1) {
    const criterion = C02_CRITERIA_TEMPLATE[index]!;
    const intent = intents[index];
    const effect = effects[index];
    const item = evidence[index];
    const turn = turns[index];
    const turnPayload = dataRecord(turn?.payload);
    if (
      !intent ||
      !effect ||
      !item ||
      !turn ||
      !turnPayload ||
      intent.effectId !== effect.effectId ||
      intent.taskId !== task.taskId ||
      effect.taskId !== task.taskId ||
      item.taskId !== task.taskId ||
      intent.objectiveRevision !== task.objectiveRevision ||
      effect.objectiveRevision !== task.objectiveRevision ||
      item.objectiveRevision !== task.objectiveRevision ||
      intent.planVersion !== task.planVersion ||
      effect.planVersion !== task.planVersion ||
      item.planVersion !== task.planVersion ||
      intent.executionGeneration !== task.executionGeneration ||
      effect.executionGeneration !== task.executionGeneration ||
      intent.proposal.criterionId !== criterion.criterionId ||
      effect.criterionId !== criterion.criterionId ||
      item.criterionId !== criterion.criterionId ||
      item.admissibility !== "admitted" ||
      item.invalidatedAt !== undefined ||
      turn.taskId !== task.taskId ||
      turn.objectiveRevision !== task.objectiveRevision ||
      turn.payloadDigest !== governorDigest(turn.payload) ||
      turnPayload.turn !== index + 1 ||
      turnPayload.planVersion !== task.planVersion ||
      turnPayload.executionGeneration !== task.executionGeneration ||
      turnPayload.sourceEffectId !== effect.effectId ||
      turnPayload.sourceToolName !== params.prepared.bindings[index]?.toolName ||
      effect.createdAt !== item.observedAt ||
      item.observedAt > turn.createdAt ||
      (index > 0 && turn.createdAt < turns[index - 1]!.createdAt)
    ) {
      fail();
    }
  }
  return binding;
}
