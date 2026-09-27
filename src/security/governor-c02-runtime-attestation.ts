import type { GovernorActionIntent } from "../tasks/governor/action-intent.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorEventRecord } from "../tasks/governor/events.js";
import type { GovernorEvidenceRecord } from "../tasks/governor/evidence.js";
import type { GovernorEffectRecord } from "../tasks/governor/tool-outcome.js";
import type { GovernorTaskProjection } from "../tasks/governor/types.js";
import {
  assertGovernorC02PreparedRun,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

export const GOVERNOR_C02_ATTESTATION_SCHEMA = "openclaw.governor-c02-attestation/v1";

export type GovernorC02AttestationSnapshot = Readonly<{
  task: GovernorTaskProjection;
  sourceHighwater: Readonly<{
    sourceSequence: number;
    sourceMessageRef: string;
    taskId: string;
  }>;
  events: readonly GovernorEventRecord[];
  intents: readonly GovernorActionIntent[];
  effects: readonly GovernorEffectRecord[];
  evidence: readonly GovernorEvidenceRecord[];
}>;

export type GovernorC02AttestationBody = Readonly<{
  schema: typeof GOVERNOR_C02_ATTESTATION_SCHEMA;
  moduleId: typeof C02_SIMPLE_EFFICIENCY_ID;
  moduleVersion: typeof C02_SIMPLE_EFFICIENCY_VERSION;
  artifactDigest: string;
  hostDescriptorDigest: string;
  toolRegistryDigest: string;
  runBindingDigest: string;
  requestDigest: string;
  sessionDigest: string;
  taskId: string;
  scopeKey: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
  sourceHighwater: number;
  requestSequenceDigest: string;
  actionChainDigest: string;
  evidenceChainDigest: string;
  issuedAt: number;
}>;

declare const validatedC02AttestationBrand: unique symbol;
export type GovernorValidatedC02Attestation = GovernorC02AttestationBody &
  Readonly<{ [validatedC02AttestationBrand]: true }>;

export type GovernorC02SignedAttestation = GovernorC02AttestationBody &
  Readonly<{
    authorityKeyId: "host-receipt-v1";
    authorityVersion: 1;
    signature: string;
  }>;

const VALIDATED = new WeakSet<object>();
const ISSUED = new WeakSet<object>();
const STORE_SNAPSHOTS = new WeakSet<object>();

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function fail(): never {
  throw new Error("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

/** Store-owner boundary: only the atomic store reader calls this before returning. */
export function markGovernorC02AttestationSnapshot(
  snapshot: GovernorC02AttestationSnapshot,
): GovernorC02AttestationSnapshot {
  STORE_SNAPSHOTS.add(snapshot);
  return snapshot;
}

export function validateGovernorC02Attestation(params: {
  run: GovernorC02PreparedRun;
  snapshot: GovernorC02AttestationSnapshot;
  artifactDigest: string;
  issuedAt: number;
  opaqueActionTarget: (value: string) => string;
}): GovernorValidatedC02Attestation {
  assertGovernorC02PreparedRun(params.run);
  if (
    !STORE_SNAPSHOTS.has(params.snapshot) ||
    !validDigest(params.artifactDigest) ||
    !Number.isSafeInteger(params.issuedAt) ||
    params.issuedAt < 0
  ) {
    fail();
  }
  const { task, sourceHighwater, events, intents, effects, evidence } = params.snapshot;
  if (
    task.flowId !== params.run.requestId ||
    task.state !== "COMPLETED" ||
    sourceHighwater.taskId !== task.taskId ||
    sourceHighwater.sourceSequence !== task.authenticatedSourceSequence
  ) {
    fail();
  }
  const sourceEvent = events.findLast(
    (event) =>
      event.sourceSequence === sourceHighwater.sourceSequence &&
      event.sourceMessageId === sourceHighwater.sourceMessageRef,
  );
  const turns = events.filter((event) => event.eventType === "runtime_model_turn_recorded");
  if (
    !sourceEvent ||
    (sourceEvent.eventType !== "task_received" && sourceEvent.eventType !== "task_corrected") ||
    turns.length !== 4
  ) {
    fail();
  }
  for (const [index, event] of turns.entries()) {
    const payload = record(event.payload);
    if (
      event.taskId !== task.taskId ||
      event.scopeKey !== task.scopeKey ||
      payload?.turn !== index + 1 ||
      payload.toolCallCount !== (index < 3 ? 1 : 0)
    ) {
      fail();
    }
  }
  if (intents.length !== 3 || effects.length !== 3 || evidence.length !== 3) {
    fail();
  }
  const criteria = ["c02-observe-a", "c02-observe-b", "c02-aggregate"] as const;
  const actionMetadata: GovernorJsonValue[] = [];
  const evidenceMetadata: GovernorJsonValue[] = [];
  for (const [index, criterionId] of criteria.entries()) {
    const intent = intents[index];
    const effect = effects[index];
    const item = evidence[index];
    const binding = params.run.bindings[index];
    const payload = record(item?.payload);
    if (
      !intent ||
      !effect ||
      !item ||
      !binding ||
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
      intent.executionGeneration !== task.executionGeneration ||
      effect.executionGeneration !== task.executionGeneration ||
      intent.state !== "completed" ||
      intent.proposal.criterionId !== criterionId ||
      effect.criterionId !== criterionId ||
      item.criterionId !== criterionId ||
      effect.capability !== intent.proposal.capability ||
      effect.capabilityVersion !== intent.proposal.capabilityVersion ||
      effect.canonicalTarget !== params.opaqueActionTarget(binding.canonicalTarget) ||
      effect.toolImplementationDigest !== binding.toolDefinitionDigest ||
      effect.outcome.transport !== "completed" ||
      effect.outcome.semantic !== "success" ||
      effect.reconcileRequired ||
      item.sourceKind !== "tool" ||
      item.invalidatedAt !== undefined ||
      payload?.kind !== "host_observed_tool_result" ||
      payload.effectId !== effect.effectId ||
      payload.toolName !== binding.toolName ||
      payload.canonicalTarget !== effect.canonicalTarget ||
      payload.toolImplementationDigest !== binding.toolDefinitionDigest ||
      item.evidenceDigest !== governorDigest(item.payload) ||
      governorDigest(effect.outcome.evidence ?? null) !== item.evidenceDigest ||
      intent.createdAt > effect.createdAt ||
      effect.createdAt > item.createdAt ||
      (index > 0 && evidence[index - 1]!.createdAt > intent.createdAt)
    ) {
      fail();
    }
    actionMetadata.push({
      effectId: effect.effectId,
      criterionId,
      idempotencyKey: effect.idempotencyKey,
      proposalDigest: intent.proposalDigest,
      actionFingerprint: effect.actionFingerprint,
      argumentsDigest: effect.argumentsDigest,
    });
    evidenceMetadata.push({
      evidenceId: item.evidenceId,
      criterionId,
      evidenceDigest: item.evidenceDigest,
      semanticDigest: item.semanticDigest,
      admissionKeyId: item.admissionKeyId,
      admissionVersion: item.admissionVersion,
      admissionSignatureDigest: governorDigest(item.admissionSignature),
    });
  }
  const candidate = deepFreeze({
    schema: GOVERNOR_C02_ATTESTATION_SCHEMA,
    moduleId: C02_SIMPLE_EFFICIENCY_ID,
    moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
    artifactDigest: params.artifactDigest,
    hostDescriptorDigest: params.run.hostDescriptorDigest,
    toolRegistryDigest: params.run.toolRegistryDigest,
    runBindingDigest: params.run.runBindingDigest,
    requestDigest: governorDigest(params.run.requestId),
    sessionDigest: governorDigest(params.run.sessionKey),
    taskId: task.taskId,
    scopeKey: task.scopeKey,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    executionGeneration: task.executionGeneration,
    sourceHighwater: sourceHighwater.sourceSequence,
    requestSequenceDigest: governorDigest(
      turns.map((event) => ({ eventId: event.eventId, payloadDigest: event.payloadDigest })),
    ),
    actionChainDigest: governorDigest(actionMetadata),
    evidenceChainDigest: governorDigest(evidenceMetadata),
    issuedAt: params.issuedAt,
  }) as unknown as GovernorValidatedC02Attestation;
  VALIDATED.add(candidate);
  return candidate;
}

export function createGovernorC02AttestationAuthority(params: {
  sign: (value: GovernorJsonValue) => string;
}) {
  return Object.freeze({
    issue(candidate: GovernorValidatedC02Attestation): GovernorC02SignedAttestation {
      if (!VALIDATED.has(candidate) || ISSUED.has(candidate)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_CANDIDATE_INVALID");
      }
      const body = candidate as GovernorC02AttestationBody;
      ISSUED.add(candidate);
      return deepFreeze({
        ...body,
        authorityKeyId: "host-receipt-v1" as const,
        authorityVersion: 1 as const,
        signature: params.sign({ domain: GOVERNOR_C02_ATTESTATION_SCHEMA, body }),
      });
    },
    verify(attestation: GovernorC02SignedAttestation, installedArtifactDigest: string): boolean {
      if (
        attestation.schema !== GOVERNOR_C02_ATTESTATION_SCHEMA ||
        attestation.moduleId !== C02_SIMPLE_EFFICIENCY_ID ||
        attestation.moduleVersion !== C02_SIMPLE_EFFICIENCY_VERSION ||
        attestation.authorityKeyId !== "host-receipt-v1" ||
        attestation.authorityVersion !== 1 ||
        attestation.artifactDigest !== installedArtifactDigest
      ) {
        return false;
      }
      const {
        authorityKeyId: _keyId,
        authorityVersion: _version,
        signature,
        ...body
      } = attestation;
      return signature === params.sign({ domain: GOVERNOR_C02_ATTESTATION_SCHEMA, body });
    },
  });
}
