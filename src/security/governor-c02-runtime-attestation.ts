import crypto from "node:crypto";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { GovernorActionIntent } from "../tasks/governor/action-intent.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorEventRecord } from "../tasks/governor/events.js";
import type { GovernorEvidenceRecord } from "../tasks/governor/evidence.js";
import { withGovernorC02AtomicSnapshot } from "../tasks/governor/store-c02-attestation.js";
import type { GovernorSqliteStore } from "../tasks/governor/store.js";
import type { GovernorEffectRecord } from "../tasks/governor/tool-outcome.js";
import type { GovernorTaskProjection } from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { governorAgentLoopToolImplementationDigest } from "./governor-agent-loop-tools.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import {
  assertGovernorC02PreparedRun,
  C02_CRITERIA_TEMPLATE,
  C02_MAX_TURNS,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  evaluateGovernorC02Policy,
  governorC02RunBindingDigest,
  prepareGovernorC02Run,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";
import {
  createGovernorInstalledToolAttestor,
  governorInstalledToolDefinitionDigest,
  type OpaqueInstalledToolHandle,
} from "./governor-installed-tool-attestor.js";

const SCHEMA = "openclaw.governor-c02-runtime-attestation/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANDIDATES = new WeakSet<object>();
const ISSUED = new WeakSet<object>();

export type GovernorC02StoreSnapshot = Readonly<{
  task: GovernorTaskProjection;
  highwater: Readonly<{
    sourceBindingRef: string;
    sourceSequence: number;
    sourceMessageRef: string;
    taskId: string;
    updatedAt: number;
  }>;
  events: readonly GovernorEventRecord[];
  intents: readonly GovernorActionIntent[];
  effects: readonly GovernorEffectRecord[];
  evidence: readonly GovernorEvidenceRecord[];
}>;

type Body = Readonly<{
  schema: typeof SCHEMA;
  moduleId: typeof C02_SIMPLE_EFFICIENCY_ID;
  moduleVersion: typeof C02_SIMPLE_EFFICIENCY_VERSION;
  hostDescriptorDigest: string;
  installedToolDigest: string;
  runBindingDigest: string;
  runIdentityDigest: string;
  modulePlanDigest: string;
  taskId: string;
  opaqueFlowId: string;
  scopeKey: string;
  scopeDigest: string;
  sourceEventId: string;
  sourceEventPayloadDigest: string;
  sourceMessageDigest: string;
  sourceHighwater: number;
  sourceHighwaterUpdatedAt: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  taskCreatedAt: number;
  taskUpdatedAt: number;
  taskCompletedAt: number;
  turnChainDigest: string;
  turnTimestamps: readonly number[];
  actionChainDigest: string;
  actionTimestamps: readonly number[];
  evidenceChainDigest: string;
  evidenceTimestamps: readonly number[];
  opaqueActionTargets: readonly string[];
}>;

type Candidate = Body & Readonly<{ __candidate?: never }>;
type Signed = Body &
  Readonly<{
    issuedAt: number;
    authorityKeyId: "host-receipt-v1";
    authorityVersion: 1;
    signature: string;
  }>;

export type GovernorC02AttestationAuthority = Readonly<{
  issue(candidate: Candidate): Signed;
  verify(attestation: Signed, candidate: Candidate): boolean;
}>;

function fail(): never {
  throw new Error("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !item.enumerable || !("value" in item)))
    return undefined;
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");
}

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

function expectedPlan(task: GovernorTaskProjection): GovernorJsonValue {
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

function validateSnapshot(params: {
  store: GovernorSqliteStore;
  run: GovernorAgentLoopRunInput;
  prepared: GovernorC02PreparedRun;
  modulePlanDigest: string;
  snapshot: GovernorC02StoreSnapshot;
}): Candidate {
  assertGovernorC02PreparedRun(params.prepared);
  const { task, highwater, events, intents, effects, evidence } = params.snapshot;
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
    task.flowId !== opaque("flow-id", params.run.runId) ||
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
    governorDigest(task.plan as unknown as GovernorJsonValue) !==
      governorDigest(expectedPlan(task)) ||
    highwater.taskId !== task.taskId ||
    highwater.sourceSequence !== task.authenticatedSourceSequence ||
    highwater.sourceMessageRef !== sourceMessageRef ||
    (params.run.sourceSequence !== undefined &&
      highwater.sourceSequence !== params.run.sourceSequence) ||
    highwater.updatedAt > task.updatedAt
  )
    fail();

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
    turns.length !== 4 ||
    intents.length !== 3 ||
    effects.length !== 3 ||
    evidence.length !== 3
  )
    fail();

  const turnMetadata: GovernorJsonValue[] = [];
  for (const [index, event] of turns.entries()) {
    const payload = dataRecord(event.payload);
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
      (index > 0 && event.createdAt < turns[index - 1]!.createdAt)
    )
      fail();
    turnMetadata.push({
      eventId: event.eventId,
      payloadDigest: event.payloadDigest,
      createdAt: event.createdAt,
    });
  }

  const actionMetadata: GovernorJsonValue[] = [];
  const evidenceMetadata: GovernorJsonValue[] = [];
  const targets: string[] = [];
  for (const [index, expected] of C02_CRITERIA_TEMPLATE.entries()) {
    const intent = intents[index];
    const effect = effects[index];
    const item = evidence[index];
    const binding = params.prepared.bindings[index];
    const payload = dataRecord(item?.payload);
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
    )
      fail();
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
  }
  if (task.terminalAt < turns[3]!.createdAt || task.updatedAt !== task.terminalAt) fail();
  const body = deepFreeze({
    schema: SCHEMA,
    moduleId: C02_SIMPLE_EFFICIENCY_ID,
    moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
    hostDescriptorDigest: params.prepared.hostDescriptorDigest,
    installedToolDigest: params.prepared.hostToolRegistryDigest,
    runBindingDigest: params.prepared.runBindingDigest,
    runIdentityDigest: runIdentityDigest(params.run),
    modulePlanDigest: params.modulePlanDigest,
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
  }) as Candidate;
  CANDIDATES.add(body);
  return body;
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @internal Broker construction only; candidates cannot be manufactured by callers or tests. */
export function createGovernorC02AttestationAuthority(params: {
  sign: (value: GovernorJsonValue) => string;
  now?: () => number;
}): GovernorC02AttestationAuthority {
  return Object.freeze({
    issue(candidate) {
      if (!CANDIDATES.has(candidate) || ISSUED.has(candidate))
        throw new Error("GOVERNOR_C02_ATTESTATION_CANDIDATE_INVALID");
      const issuedAt = (params.now ?? Date.now)();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < candidate.taskCompletedAt) fail();
      const unsigned = {
        ...candidate,
        issuedAt,
        authorityKeyId: "host-receipt-v1" as const,
        authorityVersion: 1 as const,
      };
      const signature = params.sign({
        domain: SCHEMA,
        body: unsigned,
      } as unknown as GovernorJsonValue);
      const result = deepFreeze({ ...unsigned, signature });
      ISSUED.add(candidate);
      return result;
    },
    verify(attestation, candidate) {
      try {
        const record = dataRecord(attestation);
        if (
          !record ||
          !exactKeys(record, [
            ...Object.keys(candidate),
            "issuedAt",
            "authorityKeyId",
            "authorityVersion",
            "signature",
          ])
        )
          return false;
        if (
          record.schema !== SCHEMA ||
          record.authorityKeyId !== "host-receipt-v1" ||
          record.authorityVersion !== 1 ||
          typeof record.issuedAt !== "number" ||
          !Number.isSafeInteger(record.issuedAt) ||
          record.issuedAt < candidate.taskCompletedAt ||
          typeof record.signature !== "string" ||
          !SHA256.test(record.signature)
        )
          return false;
        const { signature, ...unsigned } = record;
        for (const [key, value] of Object.entries(candidate)) {
          if (
            governorDigest(value as GovernorJsonValue) !==
            governorDigest(record[key] as GovernorJsonValue)
          )
            return false;
        }
        return timingSafeEqual(
          signature,
          params.sign({ domain: SCHEMA, body: unsigned as GovernorJsonValue }),
        );
      } catch {
        return false;
      }
    },
  });
}

function criterionValue(args: unknown, key: string): string | undefined {
  const record = dataRecord(args);
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** @internal Creates only standard run scopes; no raw issuer, verifier, snapshot, or result escapes. */
export function createGovernorC02AttestationOwner(params: {
  store: GovernorSqliteStore;
  authority: GovernorC02AttestationAuthority;
  capabilities: readonly GovernorCapabilityDefinition[];
}) {
  const activeTasks = new Set<string>();
  const issuedTasks = new Set<string>();
  let closed = false;
  return Object.freeze({
    wrap(input: {
      scope: GovernorAgentLoopRunScope;
      run: GovernorAgentLoopRunInput;
      config: GovernorAgentLoopConfiguration;
      modulePlanDigest: string;
      hostDescriptorDigest: string;
    }): GovernorAgentLoopRunScope {
      if (closed || input.scope.mode !== "enforce")
        throw new Error("GOVERNOR_C02_ATTESTATION_OWNER_CLOSED");
      let prepared: GovernorC02PreparedRun | undefined;
      let attestor: ReturnType<typeof createGovernorInstalledToolAttestor> | undefined;
      let handles: readonly OpaqueInstalledToolHandle[] = [];
      let attested = false;
      let disposed = false;
      const taskId = input.scope.taskId;
      if (activeTasks.has(taskId) || issuedTasks.has(taskId))
        throw new Error("GOVERNOR_C02_ATTESTATION_TASK_ALREADY_BOUND");
      activeTasks.add(taskId);
      const prepare = (installedTools: readonly AgentTool[]) => {
        if (prepared) throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_ALREADY_PREPARED");
        input.scope.prepareTools?.(installedTools);
        const policyTools = input.scope.governedTools();
        const governed = (["read", "exec"] as const).map((toolName) => {
          const matches = installedTools.filter((tool) => tool.name === toolName);
          if (matches.length !== 1) fail();
          return matches[0]!;
        });
        if (
          new Set(installedTools).size !== installedTools.length ||
          policyTools.length !== 2 ||
          policyTools[0]?.name !== "read" ||
          policyTools[1]?.name !== "exec"
        )
          fail();
        attestor = createGovernorInstalledToolAttestor();
        handles = governed.map((tool) => {
          const binding = input.config.toolBindings.find((item) => item.toolName === tool.name);
          const capability = params.capabilities.find(
            (item) => item.capability === binding?.capability,
          );
          if (!binding || !capability) fail();
          return attestor!.attest({
            tool,
            expected: {
              toolName: tool.name,
              implementationId: binding.implementationId,
              toolDefinitionDigest: governorInstalledToolDefinitionDigest(tool),
              canonicalTargetPrefixes: [...capability.canonicalTargetPrefixes].toSorted(),
            },
          });
        });
        const identities = handles.map((handle) => attestor!.registeredTool(handle));
        const read = input.config.toolBindings[0];
        const aggregate = input.config.toolBindings[1];
        const readValues = read?.criteriaByValue ? Object.entries(read.criteriaByValue) : [];
        const aggregateValues = aggregate?.criteriaByValue
          ? Object.entries(aggregate.criteriaByValue)
          : [];
        if (
          input.config.maxTurns !== C02_MAX_TURNS ||
          input.config.expectedAssistantTextDigest !== undefined ||
          read?.toolName !== "read" ||
          read.criterionArgument !== "path" ||
          aggregate?.toolName !== "exec" ||
          aggregate.criterionArgument !== "command" ||
          readValues.length !== 2 ||
          aggregateValues.length !== 1
        )
          fail();
        const bindings = [
          ...readValues.map(([value, criterionId]) => ({ tool: read, value, criterionId })),
          ...aggregateValues.map(([value, criterionId]) => ({
            tool: aggregate,
            value,
            criterionId,
          })),
        ].map(({ tool, value, criterionId }) => {
          const identity = identities.find((item) => item.toolName === tool.toolName)!;
          return {
            toolName: tool.toolName as "read" | "exec",
            criterionId: criterionId as "c02-observe-a" | "c02-observe-b" | "c02-aggregate",
            criterionArgument: tool.criterionArgument as "path" | "command",
            criterionValue: value,
            canonicalTarget: tool.canonicalTarget,
            implementationId: identity.implementationId,
            toolDefinitionDigest: identity.toolDefinitionDigest,
          };
        });
        const material = {
          requestId: input.run.runId,
          sessionKey: input.run.sessionKey,
          hostDescriptorDigest: input.hostDescriptorDigest,
          hostToolRegistryDigest: attestor.digest(handles),
          registeredTools: identities as never,
          bindings: bindings as never,
        };
        prepared = prepareGovernorC02Run({
          ...material,
          runBindingDigest: governorC02RunBindingDigest(material),
        });
      };
      const scope: GovernorAgentLoopRunScope = Object.freeze({
        ...input.scope,
        prepareTools: prepare,
        governedTools: () =>
          attestor ? attestor.governedTools(handles) : input.scope.governedTools(),
        beforeTool(request) {
          if (!prepared || !attestor) throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_UNPREPARED");
          const handleIndex = governed.findIndex((tool) => tool.name === request.toolName);
          if (handleIndex === undefined || handleIndex < 0 || !request.tool) fail();
          attestor.assertBound(handles[handleIndex]!, request.tool);
          const attempted = prepared.bindings.find(
            (binding) =>
              binding.toolName === request.toolName &&
              criterionValue(request.args, binding.criterionArgument) === binding.criterionValue,
          )?.criterionId;
          const satisfied = new Set(
            params.store
              .listEvidence(taskId as never)
              .filter(
                (item) => item.admissibility === "admitted" && item.invalidatedAt === undefined,
              )
              .map((item) => item.criterionId),
          );
          const decision = evaluateGovernorC02Policy({
            run: prepared,
            projectionRequestId: prepared.requestId,
            projectionRunBindingDigest: prepared.runBindingDigest,
            criteria: C02_CRITERIA_TEMPLATE.map((criterion) => ({
              ...criterion,
              satisfied: satisfied.has(criterion.criterionId),
            })),
            ...(attempted ? { attemptedCriterionId: attempted } : {}),
          });
          if (decision.attempted.kind === "block")
            return { kind: "block", reasonCode: decision.attempted.reasonCode };
          return input.scope.beforeTool({ ...request, tool: policyTools[handleIndex] });
        },
        assertTerminal() {
          input.scope.assertTerminal();
          if (attested) return;
          if (!prepared) throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_UNPREPARED");
          const candidate = withGovernorC02AtomicSnapshot({
            store: params.store,
            taskId: taskId as never,
            consume: (snapshot) =>
              validateSnapshot({
                store: params.store,
                run: input.run,
                prepared: prepared!,
                modulePlanDigest: input.modulePlanDigest,
                snapshot,
              }),
          });
          const result = params.authority.issue(candidate);
          if (!params.authority.verify(result, candidate))
            throw new Error("GOVERNOR_C02_ATTESTATION_SIGNATURE_INVALID");
          attested = true;
          issuedTasks.add(taskId);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          try {
            input.scope.dispose();
          } finally {
            attestor?.close();
            activeTasks.delete(taskId);
          }
        },
      });
      return scope;
    },
    close() {
      closed = true;
    },
  });
}
