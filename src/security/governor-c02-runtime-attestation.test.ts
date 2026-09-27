import { describe, expect, it } from "vitest";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import {
  createGovernorC02AttestationAuthority,
  markGovernorC02AttestationSnapshot,
  validateGovernorC02Attestation,
  type GovernorC02AttestationSnapshot,
} from "./governor-c02-runtime-attestation.js";
import {
  governorC02RunBindingDigest,
  governorC02ToolRegistryDigest,
  prepareGovernorC02Run,
} from "./governor-c02-simple-efficiency-policy.js";

const TASK_ID = "gtask_c02" as GovernorTaskId;
const SCOPE = "1".repeat(64);
const A = "a".repeat(64);
const B = "b".repeat(64);
const ARTIFACT = "f".repeat(64);

function prepared() {
  const registeredTools = [
    {
      toolName: "read" as const,
      implementationId: "installed:read",
      toolDefinitionDigest: A,
      canonicalTargetPrefixes: ["campaign://c02/observe"],
    },
    {
      toolName: "exec" as const,
      implementationId: "installed:exec",
      toolDefinitionDigest: B,
      canonicalTargetPrefixes: ["campaign://c02/aggregate"],
    },
  ];
  const material = {
    requestId: "run-c02",
    sessionKey: "session-c02",
    hostDescriptorDigest: "c".repeat(64),
    hostToolRegistryDigest: governorC02ToolRegistryDigest(registeredTools),
    registeredTools,
    bindings: [
      {
        toolName: "read" as const,
        criterionId: "c02-observe-a" as const,
        criterionArgument: "path" as const,
        criterionValue: "/case/a",
        canonicalTarget: "campaign://c02/observe/a",
        implementationId: "installed:read",
        toolDefinitionDigest: A,
      },
      {
        toolName: "read" as const,
        criterionId: "c02-observe-b" as const,
        criterionArgument: "path" as const,
        criterionValue: "/case/b",
        canonicalTarget: "campaign://c02/observe/b",
        implementationId: "installed:read",
        toolDefinitionDigest: A,
      },
      {
        toolName: "exec" as const,
        criterionId: "c02-aggregate" as const,
        criterionArgument: "command" as const,
        criterionValue: "aggregate",
        canonicalTarget: "campaign://c02/aggregate",
        implementationId: "installed:exec",
        toolDefinitionDigest: B,
      },
    ],
  };
  return prepareGovernorC02Run({
    ...material,
    runBindingDigest: governorC02RunBindingDigest(material),
  });
}

function snapshot(): GovernorC02AttestationSnapshot {
  const run = prepared();
  const criteria = ["c02-observe-a", "c02-observe-b", "c02-aggregate"];
  const effects = criteria.map((criterionId, index) => {
    const binding = run.bindings[index]!;
    return {
      taskId: TASK_ID,
      effectId: `geffect_${index + 1}`,
      idempotencyKey: `idem-${index + 1}`,
      taskVersion: 10 + index,
      objectiveRevision: 1,
      planVersion: 1,
      leaseEpoch: 1,
      executionGeneration: 1,
      criterionId,
      capability: binding.toolName,
      capabilityVersion: "v1",
      canonicalTarget: `opaque:${binding.canonicalTarget}`,
      expectedEvidence: "digest",
      sourceRank: "structured_exact",
      stopCondition: `criterion:${criterionId}`,
      mutating: false,
      argumentsDigest: governorDigest(binding.criterionValue),
      toolImplementationDigest: binding.toolDefinitionDigest,
      actionFingerprint: `fingerprint-${index + 1}`,
      progressVectorHash: `progress-${index + 1}`,
      outcome: {
        transport: "completed",
        semantic: "success",
        sideEffect: "none",
        verification: "not_required",
        summaryCode: "tool_success",
      },
      verificationState: "not_required",
      reconcileRequired: false,
      createdAt: 20 + index,
      updatedAt: 20 + index,
    };
  });
  const intents = effects.map((effect) => ({
    taskId: TASK_ID,
    effectId: effect.effectId,
    idempotencyKey: effect.idempotencyKey,
    taskVersion: effect.taskVersion,
    objectiveRevision: 1,
    planVersion: 1,
    leaseEpoch: 1,
    executionGeneration: 1,
    approvalRequired: false,
    approvalPolicyDigest: "policy",
    state: "completed",
    claimEpoch: 1,
    proposal: {
      taskId: TASK_ID,
      effectId: effect.effectId,
      criterionId: effect.criterionId,
      capability: effect.capability,
      capabilityVersion: effect.capabilityVersion,
      canonicalTarget: effect.canonicalTarget,
      expectedEvidence: effect.expectedEvidence,
      sourceRank: effect.sourceRank,
      stopCondition: effect.stopCondition,
      mutating: false,
      argumentsDigest: effect.argumentsDigest,
      toolImplementationDigest: effect.toolImplementationDigest,
    },
    proposalDigest: "proposal-" + effect.effectId,
    actionFingerprint: effect.actionFingerprint,
    progressVectorHash: effect.progressVectorHash,
    forceReplanAfterOutcome: false,
    createdAt: effect.createdAt,
    completedAt: effect.updatedAt,
    updatedAt: effect.updatedAt,
  }));
  const evidence = effects.map((effect, index) => {
    const binding = run.bindings[index]!;
    const payload = {
      kind: "host_observed_tool_result",
      effectId: effect.effectId,
      toolName: binding.toolName,
      capability: effect.capability,
      capabilityVersion: effect.capabilityVersion,
      canonicalTarget: effect.canonicalTarget,
      toolImplementationDigest: binding.toolDefinitionDigest,
      resultDigest: governorDigest(index),
      observationKey: binding.criterionValue,
      dependsOnCriteria: index === 2 ? ["c02-observe-a", "c02-observe-b"] : [],
    };
    Object.assign(effect.outcome, { evidence: payload });
    return {
      evidenceId: `evidence_${TASK_ID}_${effect.effectId}`,
      taskId: TASK_ID,
      criterionId: criteria[index],
      sourceKind: "tool",
      sourceIdentity: `oesr_${"d".repeat(64)}`,
      taskVersion: effect.taskVersion,
      objectiveRevision: 1,
      planVersion: 1,
      scopeKey: SCOPE,
      observedAt: effect.updatedAt,
      payload,
      evidenceDigest: governorDigest(payload),
      predicate: `criterion:${criteria[index]}`,
      value: payload,
      semanticDigest: governorDigest({ predicate: `criterion:${criteria[index]}`, value: payload }),
      admissibility: "admitted",
      createdAt: effect.updatedAt,
      admissionKeyId: "evidence-v1",
      admissionVersion: 1,
      admissionSignature: `${index + 1}`.repeat(64),
    };
  });
  const events = [
    {
      eventId: "gevent_source",
      taskId: TASK_ID,
      scopeKey: SCOPE,
      sourceMessageId: "2".repeat(64),
      sourceSequence: 4,
      eventType: "task_received",
      taskVersion: 1,
      objectiveRevision: 1,
      payload: { mode: "FOCUSED" },
      payloadDigest: governorDigest({ mode: "FOCUSED" }),
      createdAt: 1,
    },
    ...[1, 2, 3, 4].map((turn) => {
      const payload = { turn, toolCallCount: turn < 4 ? 1 : 0 };
      return {
        eventId: `gevent_turn_${turn}`,
        taskId: TASK_ID,
        scopeKey: SCOPE,
        eventType: "runtime_model_turn_recorded",
        taskVersion: 20 + turn,
        objectiveRevision: 1,
        payload,
        payloadDigest: governorDigest(payload),
        createdAt: 30 + turn,
      };
    }),
  ];
  return markGovernorC02AttestationSnapshot({
    task: {
      taskId: TASK_ID,
      flowId: run.requestId,
      scopeKey: SCOPE,
      state: "COMPLETED",
      authenticatedSourceSequence: 4,
      taskVersion: 30,
      objectiveRevision: 1,
      planVersion: 1,
      executionGeneration: 1,
    } as never,
    sourceHighwater: { sourceSequence: 4, sourceMessageRef: "2".repeat(64), taskId: TASK_ID },
    events: events as never,
    intents: intents as never,
    effects: effects as never,
    evidence: evidence as never,
  });
}

function validate(value = snapshot()) {
  return validateGovernorC02Attestation({
    run: prepared(),
    snapshot: value,
    artifactDigest: ARTIFACT,
    issuedAt: 100,
    opaqueActionTarget: (target) => `opaque:${target}`,
  });
}

describe("runtime-owned C02 attestation", () => {
  it("issues one immutable metadata-only artifact-bound result", () => {
    const authority = createGovernorC02AttestationAuthority({ sign: governorDigest });
    const result = authority.issue(validate());
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("events");
    expect(result).not.toHaveProperty("evidence");
    expect(result).not.toHaveProperty("sessionKey");
    expect(authority.verify(result, ARTIFACT)).toBe(true);
    expect(authority.verify(result, "e".repeat(64))).toBe(false);
    expect(authority.verify({ ...result, taskVersion: 31 }, ARTIFACT)).toBe(false);
  });

  it("rejects unowned snapshots and caller-manufactured signing candidates", () => {
    const owned = snapshot();
    expect(() =>
      validateGovernorC02Attestation({
        run: prepared(),
        snapshot: { ...owned },
        artifactDigest: ARTIFACT,
        issuedAt: 100,
        opaqueActionTarget: (target) => `opaque:${target}`,
      }),
    ).toThrow("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
    const authority = createGovernorC02AttestationAuthority({ sign: governorDigest });
    expect(() => authority.issue({ ...validate() } as never)).toThrow(
      "GOVERNOR_C02_ATTESTATION_CANDIDATE_INVALID",
    );
  });

  it("fails closed on request, highwater, action, tool, task, and evidence substitutions", () => {
    const base = snapshot();
    const cases = [
      { ...base, sourceHighwater: { ...base.sourceHighwater, sourceSequence: 3 } },
      { ...base, events: base.events.filter((event) => event.eventId !== "gevent_turn_2") },
      {
        ...base,
        events: [base.events[0]!, base.events[2]!, base.events[1]!, ...base.events.slice(3)],
      },
      { ...base, intents: [base.intents[1]!, base.intents[0]!, base.intents[2]!] },
      { ...base, effects: [base.effects[1]!, base.effects[0]!, base.effects[2]!] },
      { ...base, evidence: [base.evidence[1]!, base.evidence[0]!, base.evidence[2]!] },
      {
        ...base,
        effects: [{ ...base.effects[0]!, taskId: "gtask_other" }, ...base.effects.slice(1)],
      },
      {
        ...base,
        effects: [{ ...base.effects[0]!, toolImplementationDigest: B }, ...base.effects.slice(1)],
      },
      {
        ...base,
        evidence: [{ ...base.evidence[0]!, evidenceDigest: B }, ...base.evidence.slice(1)],
      },
    ].map((item) => markGovernorC02AttestationSnapshot(item as GovernorC02AttestationSnapshot));
    for (const hostile of cases) {
      expect(() => validate(hostile)).toThrow("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
    }
  });
});
