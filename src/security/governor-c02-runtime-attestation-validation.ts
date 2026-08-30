import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorSqliteStore } from "../tasks/governor/store.js";
import { governorAgentLoopToolImplementationDigest } from "./governor-agent-loop-tools.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import {
  CANDIDATES,
  CHECKPOINT_PREFIX,
  FINN_REQUEST_ID,
  SCHEMA,
  SHA256,
  type Body,
  type Candidate,
  type GovernorC02StoreSnapshot,
  dataRecord,
  deepFreeze,
  exactKeys,
  fail,
} from "./governor-c02-runtime-attestation-model.js";
import {
  assertGovernorC02PreparedRun,
  C02_CRITERIA_TEMPLATE,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

function runIdentityDigest(run: GovernorAgentLoopRunInput): string {
  return governorDigest({
    runId: run.runId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    agentId: run.agentId,
    workspaceId: run.workspaceId,
    channel: run.channel,
    accountId: run.accountId,
    principalId: run.principalId,
    conversationId: run.conversationId,
    sourceMessageId: run.sourceMessageId,
    sourceSequence: run.sourceSequence ?? null,
    promptDigest: governorDigest(run.prompt),
  });
}

function expectedPlan(): GovernorJsonValue {
  const stepByCriterion = new Map<string, string>(
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
      dependsOn: criterion.dependsOn.map((item) => stepByCriterion.get(item)!),
    })),
  };
}

export function validateGovernorC02Snapshot(params: {
  store: GovernorSqliteStore;
  run: GovernorAgentLoopRunInput;
  prepared: GovernorC02PreparedRun;
  modulePlanDigest: string;
  initialGatewayInvocationId: string;
  systemdInvocationId: string;
  snapshot: GovernorC02StoreSnapshot;
}): Candidate {
  assertGovernorC02PreparedRun(params.prepared);
  const { task, highwater, events, intents, effects, evidence, checkpoints } = params.snapshot;
  const opaque = (kind: string, value: string) => params.store.opaqueReference(kind, value);
  const expectedScope = {
    principalId: opaque("principal", params.run.principalId),
    channel: opaque("channel", params.run.channel),
    accountId: opaque("account", params.run.accountId),
    conversationId: opaque("conversation", params.run.conversationId),
    sessionId: opaque("session", params.run.sessionId),
    agentId: opaque("agent", params.run.agentId),
    workspaceId: opaque("workspace", params.run.workspaceId),
  };
  const sourceMessageRef = opaque(`source-message:${task.scopeKey}`, params.run.sourceMessageId);
  if (
    task.state !== "COMPLETED" ||
    task.terminalAt === undefined ||
    task.flowId !== opaque("flow-id", params.initialGatewayInvocationId) ||
    governorDigest(task.scope as unknown as GovernorJsonValue) !==
      governorDigest(expectedScope as unknown as GovernorJsonValue) ||
    task.mode !== "FOCUSED" ||
    task.contract.completionCriteria.length !== 3 ||
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
    highwater.taskId !== task.taskId ||
    highwater.sourceSequence !== task.authenticatedSourceSequence ||
    highwater.sourceMessageRef !== sourceMessageRef ||
    (params.run.sourceSequence !== undefined &&
      highwater.sourceSequence !== params.run.sourceSequence) ||
    highwater.updatedAt > task.updatedAt
  ) {
    fail();
  }

  const sourceEvent = events.findLast(
    (event) =>
      event.sourceMessageId === highwater.sourceMessageRef &&
      event.sourceSequence === highwater.sourceSequence &&
      (event.eventType === "task_received" || event.eventType === "task_corrected"),
  );
  const turns = events.filter((event) => {
    const payload = dataRecord(event.payload);
    return (
      event.eventType === "runtime_model_turn_recorded" &&
      payload?.executionGeneration === task.executionGeneration
    );
  });
  if (
    !sourceEvent ||
    sourceEvent.taskId !== task.taskId ||
    sourceEvent.scopeKey !== task.scopeKey ||
    sourceEvent.objectiveRevision !== task.objectiveRevision ||
    sourceEvent.taskVersion > task.taskVersion ||
    sourceEvent.payloadDigest !== governorDigest(sourceEvent.payload) ||
    sourceEvent.createdAt < task.createdAt ||
    sourceEvent.createdAt > task.updatedAt ||
    turns.length !== 4 ||
    intents.length !== 3 ||
    effects.length !== 3 ||
    evidence.length !== 3 ||
    checkpoints.length !== 1
  ) {
    fail();
  }

  const checkpoint = checkpoints[0]!;
  const bindingFact = checkpoint.verifiedFacts.find((fact) =>
    fact.claim.startsWith(CHECKPOINT_PREFIX),
  );
  const observeFact = checkpoint.verifiedFacts.find(
    (fact) => fact.claim === "c02-observe-b-admitted",
  );
  let checkpointBinding: Readonly<Record<string, unknown>> | undefined;
  try {
    checkpointBinding = bindingFact
      ? dataRecord(JSON.parse(bindingFact.claim.slice(CHECKPOINT_PREFIX.length)))
      : undefined;
  } catch {
    fail();
  }
  if (
    !bindingFact ||
    !observeFact ||
    checkpoint.verifiedFacts.length !== 2 ||
    !checkpointBinding ||
    !exactKeys(checkpointBinding, [
      "taskId",
      "sessionId",
      "systemdInvocationId",
      "gatewayInvocationId",
      "hostDescriptorDigest",
      "modulePlanDigest",
      "installedToolDigest",
    ]) ||
    checkpoint.checkpointId !== `c02-restart-${task.taskId}` ||
    checkpoint.taskId !== task.taskId ||
    checkpoint.objectiveRevision !== task.objectiveRevision ||
    checkpoint.planVersion !== task.planVersion ||
    checkpoint.taskVersion <= 0 ||
    checkpoint.taskVersion > task.taskVersion ||
    checkpoint.discardedAssumptions.length !== 0 ||
    checkpoint.unresolvedQuestions.length !== 1 ||
    checkpoint.unresolvedQuestions[0] !== "gateway restart required" ||
    checkpoint.nextDiscriminatingAction !== "restart gateway then execute c02-aggregate" ||
    checkpoint.competingHypotheses.length !== 0 ||
    checkpointBinding.taskId !== task.taskId ||
    checkpointBinding.sessionId !== params.run.sessionId ||
    checkpointBinding.systemdInvocationId === params.systemdInvocationId ||
    checkpointBinding.gatewayInvocationId !== params.initialGatewayInvocationId ||
    checkpointBinding.hostDescriptorDigest !== params.prepared.hostDescriptorDigest ||
    checkpointBinding.modulePlanDigest !== params.modulePlanDigest ||
    checkpointBinding.installedToolDigest !== params.prepared.hostToolRegistryDigest ||
    bindingFact.evidenceDigest !==
      governorDigest(checkpointBinding as unknown as GovernorJsonValue) ||
    observeFact.evidenceDigest !== evidence[1]?.evidenceDigest ||
    checkpoint.createdAt <= (evidence[1]?.observedAt ?? Number.MAX_SAFE_INTEGER) ||
    checkpoint.createdAt >= (intents[2]?.createdAt ?? -1)
  ) {
    fail();
  }

  const turnMetadata: GovernorJsonValue[] = [];
  let coordinatorRequestIds: readonly string[] = [];
  for (const [index, event] of turns.entries()) {
    const payload = dataRecord(event.payload);
    const finnRequestIds = Array.isArray(payload?.finnRequestIds)
      ? payload.finnRequestIds
      : undefined;
    if (
      !payload ||
      !exactKeys(payload, [
        "turn",
        "assistantTextDigest",
        "toolCallCount",
        "stopReason",
        "planVersion",
        "executionGeneration",
        "satisfiedCriteria",
        "remainingCriteria",
        "progressDigest",
        "sourceEffectId",
        "sourceToolName",
        "sourceResultDigest",
        "finnRequestIds",
        "finnRequestIdEvidenceComplete",
      ]) ||
      event.taskId !== task.taskId ||
      event.scopeKey !== task.scopeKey ||
      event.objectiveRevision !== task.objectiveRevision ||
      event.taskVersion > task.taskVersion ||
      event.payloadDigest !== governorDigest(event.payload) ||
      payload.turn !== index + 1 ||
      payload.toolCallCount !== (index < 3 ? 1 : 0) ||
      payload.planVersion !== task.planVersion ||
      payload.executionGeneration !== task.executionGeneration ||
      payload.satisfiedCriteria !== Math.min(index + 1, 3) ||
      payload.remainingCriteria !== Math.max(2 - index, 0) ||
      typeof payload.stopReason !== "string" ||
      payload.stopReason.length === 0 ||
      payload.stopReason === "error" ||
      payload.stopReason === "aborted" ||
      typeof payload.assistantTextDigest !== "string" ||
      !SHA256.test(payload.assistantTextDigest) ||
      typeof payload.progressDigest !== "string" ||
      !SHA256.test(payload.progressDigest) ||
      (index < 3
        ? typeof payload.sourceEffectId !== "string" ||
          typeof payload.sourceToolName !== "string" ||
          typeof payload.sourceResultDigest !== "string" ||
          !SHA256.test(payload.sourceResultDigest)
        : payload.sourceEffectId !== null ||
          payload.sourceToolName !== null ||
          payload.sourceResultDigest !== null) ||
      payload.finnRequestIdEvidenceComplete !== true ||
      !finnRequestIds ||
      finnRequestIds.length !== index + 1 ||
      finnRequestIds.some(
        (requestId) => typeof requestId !== "string" || !FINN_REQUEST_ID.test(requestId),
      ) ||
      new Set(finnRequestIds).size !== finnRequestIds.length ||
      coordinatorRequestIds.some(
        (requestId, requestIndex) => finnRequestIds[requestIndex] !== requestId,
      ) ||
      (index > 0 && event.createdAt < turns[index - 1]!.createdAt)
    ) {
      fail();
    }
    coordinatorRequestIds = Object.freeze([...finnRequestIds] as string[]);
    turnMetadata.push({
      eventId: event.eventId,
      payloadDigest: event.payloadDigest,
      createdAt: event.createdAt,
      coordinatorRequestIds: [...coordinatorRequestIds],
    });
  }

  const actionMetadata: GovernorJsonValue[] = [];
  const evidenceMetadata: GovernorJsonValue[] = [];
  const targets: string[] = [];
  const toolResults: Body["toolResults"][number][] = [];
  for (const [index, expected] of C02_CRITERIA_TEMPLATE.entries()) {
    const intent = intents[index];
    const effect = effects[index];
    const item = evidence[index];
    const binding = params.prepared.bindings[index];
    const payload = dataRecord(item?.payload);
    const turnPayload = dataRecord(turns[index]?.payload);
    const opaqueTarget = binding ? opaque("action-target", binding.canonicalTarget) : "";
    const argumentsDigest = binding
      ? governorDigest({ [binding.criterionArgument]: binding.criterionValue })
      : "";
    if (
      !intent ||
      !effect ||
      !item ||
      !binding ||
      !payload ||
      !turnPayload ||
      !exactKeys(payload, [
        "kind",
        "effectId",
        "toolName",
        "capability",
        "capabilityVersion",
        "canonicalTarget",
        "toolImplementationDigest",
        "resultDigest",
        "observationKey",
        "dependsOnCriteria",
      ]) ||
      intent.effectId !== effect.effectId ||
      item.evidenceId !== `evidence_${task.taskId}_${effect.effectId}` ||
      intent.taskId !== task.taskId ||
      effect.taskId !== task.taskId ||
      item.taskId !== task.taskId ||
      item.scopeKey !== task.scopeKey ||
      intent.taskVersion !== effect.taskVersion ||
      item.taskVersion !== effect.taskVersion ||
      intent.objectiveRevision !== task.objectiveRevision ||
      effect.objectiveRevision !== task.objectiveRevision ||
      item.objectiveRevision !== task.objectiveRevision ||
      intent.planVersion !== task.planVersion ||
      effect.planVersion !== task.planVersion ||
      item.planVersion !== task.planVersion ||
      intent.leaseEpoch !== task.leaseEpoch ||
      effect.leaseEpoch !== task.leaseEpoch ||
      intent.executionGeneration !== task.executionGeneration ||
      effect.executionGeneration !== task.executionGeneration ||
      intent.state !== "completed" ||
      intent.completedAt === undefined ||
      intent.proposal.criterionId !== expected.criterionId ||
      effect.criterionId !== expected.criterionId ||
      item.criterionId !== expected.criterionId ||
      intent.proposalDigest !== governorDigest(intent.proposal as unknown as GovernorJsonValue) ||
      intent.proposal.capability !== effect.capability ||
      intent.proposal.capabilityVersion !== effect.capabilityVersion ||
      intent.proposal.argumentsDigest !== argumentsDigest ||
      effect.argumentsDigest !== argumentsDigest ||
      effect.canonicalTarget !== opaqueTarget ||
      effect.toolImplementationDigest !==
        governorAgentLoopToolImplementationDigest(binding.implementationId as never) ||
      effect.actionFingerprint !== intent.actionFingerprint ||
      effect.progressVectorHash !== intent.progressVectorHash ||
      effect.outcome.transport !== "completed" ||
      effect.outcome.semantic !== "success" ||
      effect.outcome.sideEffect !== "none" ||
      effect.outcome.verification !== "not_required" ||
      effect.reconcileRequired ||
      effect.verificationState !== "not_required" ||
      item.sourceKind !== "tool" ||
      item.admissibility !== "admitted" ||
      item.invalidatedAt !== undefined ||
      item.admissionVersion !== 1 ||
      !SHA256.test(item.admissionSignature) ||
      payload.kind !== "host_observed_tool_result" ||
      payload.effectId !== effect.effectId ||
      turnPayload.sourceEffectId !== effect.effectId ||
      turnPayload.sourceToolName !== binding.toolName ||
      turnPayload.sourceResultDigest !== payload.resultDigest ||
      payload.toolName !== binding.toolName ||
      payload.capability !== effect.capability ||
      payload.capabilityVersion !== effect.capabilityVersion ||
      payload.canonicalTarget !== opaqueTarget ||
      payload.toolImplementationDigest !== effect.toolImplementationDigest ||
      payload.observationKey !== binding.criterionValue ||
      governorDigest(payload.dependsOnCriteria as GovernorJsonValue) !==
        governorDigest(expected.dependsOn as unknown as GovernorJsonValue) ||
      typeof payload.resultDigest !== "string" ||
      !SHA256.test(payload.resultDigest) ||
      item.evidenceDigest !== governorDigest(item.payload) ||
      governorDigest(effect.outcome.evidence ?? null) !== item.evidenceDigest ||
      item.predicate !== `criterion:${expected.criterionId}` ||
      governorDigest(item.value) !== governorDigest(item.payload) ||
      item.semanticDigest !== governorDigest({ predicate: item.predicate, value: item.value }) ||
      effect.createdAt !== effect.updatedAt ||
      effect.createdAt !== intent.completedAt ||
      effect.createdAt !== item.observedAt ||
      item.observedAt !== item.createdAt ||
      intent.createdAt > effect.createdAt ||
      effect.createdAt > turns[index]!.createdAt ||
      (index > 0 && intent.createdAt < turns[index - 1]!.createdAt)
    ) {
      fail();
    }
    targets.push(opaqueTarget);
    actionMetadata.push({
      effectId: effect.effectId,
      criterionId: expected.criterionId,
      proposalDigest: intent.proposalDigest,
      actionFingerprint: effect.actionFingerprint,
      argumentsDigest,
      opaqueTarget,
    });
    evidenceMetadata.push({
      evidenceId: item.evidenceId,
      evidenceDigest: item.evidenceDigest,
      semanticDigest: item.semanticDigest,
      admissionKeyId: item.admissionKeyId,
      admissionVersion: item.admissionVersion,
      admissionSignatureDigest: governorDigest(item.admissionSignature),
    });
    toolResults.push({
      effectId: effect.effectId,
      toolName: binding.toolName,
      resultDigest: payload.resultDigest,
    });
  }
  if (task.terminalAt < turns[3]!.createdAt || task.updatedAt !== task.terminalAt) {
    fail();
  }
  const body = deepFreeze({
    schema: SCHEMA,
    moduleId: C02_SIMPLE_EFFICIENCY_ID,
    moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
    hostDescriptorDigest: params.prepared.hostDescriptorDigest,
    installedToolDigest: params.prepared.hostToolRegistryDigest,
    runBindingDigest: params.prepared.runBindingDigest,
    runIdentityDigest: runIdentityDigest(params.run),
    modulePlanDigest: params.modulePlanDigest,
    runId: params.run.runId,
    sessionId: params.run.sessionId,
    gatewayInvocationId: params.run.runId,
    initialGatewayInvocationId: params.initialGatewayInvocationId,
    systemdInvocationId: params.systemdInvocationId,
    initialSystemdInvocationId: checkpointBinding.systemdInvocationId,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: governorDigest(checkpoint as unknown as GovernorJsonValue),
    checkpointCreatedAt: checkpoint.createdAt,
    decision: "complete",
    reasonCode: "C02_EXACT_FLOW_ATTESTED",
    coordinatorRequestIds,
    taskId: task.taskId,
    opaqueFlowId: task.flowId!,
    scopeKey: task.scopeKey,
    scopeDigest: governorDigest(task.scope as unknown as GovernorJsonValue),
    sourceEventId: sourceEvent.eventId,
    sourceEventPayloadDigest: sourceEvent.payloadDigest,
    sourceMessageDigest: governorDigest(highwater.sourceMessageRef),
    sourceHighwater: highwater.sourceSequence,
    sourceHighwaterUpdatedAt: highwater.updatedAt,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    leaseEpoch: task.leaseEpoch,
    executionGeneration: task.executionGeneration,
    taskCreatedAt: task.createdAt,
    taskUpdatedAt: task.updatedAt,
    taskCompletedAt: task.terminalAt,
    turnChainDigest: governorDigest(turnMetadata),
    turnTimestamps: turns.map((event) => event.createdAt),
    actionChainDigest: governorDigest(actionMetadata),
    actionTimestamps: effects.map((effect) => effect.createdAt),
    evidenceChainDigest: governorDigest(evidenceMetadata),
    evidenceTimestamps: evidence.map((item) => item.observedAt),
    opaqueActionTargets: targets,
    toolResults,
  }) as Candidate;
  CANDIDATES.add(body);
  return body;
}
