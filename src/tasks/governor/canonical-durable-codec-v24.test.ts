import { describe, expect, it } from "vitest";
import { governorDigest } from "./canonical-json.js";
import { createGovernorEventRecord } from "./events.js";
import {
  bindEnvelope,
  bindJob,
  governorFanoutJobDigest,
  governorFaninEnvelopeDigest,
  parseEnvelope,
  parseJob,
  parseReducerResult,
  type GovernorFaninEnvelope,
  type GovernorFanoutJob,
} from "./fanout-codec.js";
import {
  bindGovernorOutbox,
  governorOutboxDeliveryKey,
  governorOutboxPendingDeliveryKey,
  parseGovernorOutbox,
  type GovernorOutboxRecord,
} from "./outbox-codec.js";
import { GovernorSecretRejectedError } from "./secret-filter.js";
import {
  bindEffect,
  bindEvent,
  bindTask,
  parseEffectRow,
  parseEventRow,
  parseTaskRow,
} from "./store-codec.js";
import { createGovernorEffectRecord } from "./tool-outcome.js";
import {
  createGovernorEffectId,
  createGovernorIdentityContext,
  createGovernorTaskId,
  createGovernorTaskProjection,
  opaqueGovernorReference,
} from "./types.js";

const identity = createGovernorIdentityContext("synthetic-v24-codec-identity-key");

function taskFixture() {
  return createGovernorTaskProjection({
    taskId: createGovernorTaskId("v24-codec"),
    scope: {
      principalId: "principal-fixture",
      channel: "synthetic",
      accountId: "account-fixture",
      conversationId: "conversation-fixture",
      sessionId: "session-fixture",
      agentId: "agent-fixture",
      workspaceId: "workspace-fixture",
    },
    mode: "DEEP",
    contract: {
      objective: "Validate durable canonical bindings",
      constraints: [],
      knownFacts: [],
      unknowns: [],
      completionCriteria: [
        { criterionId: "codec", description: "Canonical rows remain bound", mandatory: true },
      ],
      authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
    },
    authenticatedSourceSequence: 1,
    now: 10,
    identity,
  });
}

function effectFixture(task = taskFixture()) {
  return createGovernorEffectRecord({
    proposal: {
      taskId: task.taskId,
      effectId: createGovernorEffectId("v24-codec"),
      criterionId: "codec",
      capability: "synthetic.inspect",
      capabilityVersion: "1",
      canonicalTarget: opaqueGovernorReference("target", "fixture", identity),
      expectedEvidence: "canonical fixture",
      sourceRank: "structured_exact",
      stopCondition: "bound row accepted",
      mutating: false,
      argumentsDigest: governorDigest({ fixture: true }),
    },
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    leaseEpoch: task.leaseEpoch,
    executionGeneration: task.executionGeneration,
    progressVector: { checked: true },
    outcome: {
      transport: "completed",
      semantic: "success",
      sideEffect: "none",
      verification: "verified",
      summaryCode: "fixture_verified",
    },
    now: 20,
    identity,
  });
}

describe("governor V24 canonical durable codecs", () => {
  it("rejects altered task, event, and effect JSON or scalar columns", () => {
    const task = taskFixture();
    const taskRow = bindTask(task) as unknown as Parameters<typeof parseTaskRow>[0];
    expect(parseTaskRow(taskRow)).toEqual(task);
    expect(() =>
      parseTaskRow({
        ...taskRow,
        projection_json: JSON.stringify({ ...task, objectiveRevision: 2 }),
      }),
    ).toThrow(/GOVERNOR_TASK_PROJECTION_BINDING_INVALID/u);
    expect(() => parseTaskRow({ ...taskRow, scope_key: "raw-scope" })).toThrow();

    const event = createGovernorEventRecord({
      task,
      eventType: "checkpoint_recorded",
      payload: { checkpoint: "fixture" },
      now: 21,
    });
    const eventRow = bindEvent(event) as unknown as Parameters<typeof parseEventRow>[0];
    expect(parseEventRow(eventRow)).toEqual(event);
    expect(() => parseEventRow({ ...eventRow, event_type: "task_corrected" })).toThrow(
      /GOVERNOR_EVENT/u,
    );
    expect(() =>
      parseEventRow({ ...eventRow, payload_json: JSON.stringify({ checkpoint: "changed" }) }),
    ).toThrow(/GOVERNOR_EVENT/u);

    const effect = effectFixture(task);
    const effectRow = bindEffect(effect) as unknown as Parameters<typeof parseEffectRow>[0];
    expect(parseEffectRow(effectRow)).toEqual(effect);
    expect(() => parseEffectRow({ ...effectRow, capability: "synthetic.changed" })).toThrow(
      /GOVERNOR_EFFECT_BINDING_INVALID/u,
    );
    expect(() =>
      parseEffectRow({
        ...effectRow,
        outcome_json: JSON.stringify({ ...effect.outcome, summaryCode: "changed" }),
      }),
    ).toThrow(/GOVERNOR_EFFECT_BINDING_INVALID/u);
  });

  it("binds fan-in envelope content and reducer result to every current fence", () => {
    const task = taskFixture();
    const job: GovernorFanoutJob = {
      jobId: "job-v24",
      taskId: task.taskId,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      round: 1,
      queueSequence: 1,
      priority: 0,
      fanoutGroup: "synthetic",
      state: "queued",
      taskVersion: task.taskVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      claimEpoch: 0,
      payload: { request: "bounded" },
      createdAt: 29,
      updatedAt: 29,
    };
    const jobRow = bindJob(job) as unknown as Parameters<typeof parseJob>[0];
    expect(jobRow.job_digest).toBe(governorFanoutJobDigest(job));
    expect(parseJob(jobRow)).toEqual(job);
    expect(() =>
      parseJob({ ...jobRow, payload_json: JSON.stringify({ request: "changed" }) }),
    ).toThrow(/GOVERNOR_FANOUT_JOB_BINDING_INVALID/u);
    expect(() => parseJob({ ...jobRow, state: "running" })).toThrow(
      /GOVERNOR_FANOUT_JOB_BINDING_INVALID/u,
    );
    expect(() => parseJob({ ...jobRow, objective_revision: 2 })).toThrow(
      /GOVERNOR_FANOUT_JOB_BINDING_INVALID/u,
    );

    const base = {
      envelopeId: "envelope-v24",
      jobId: "job-v24",
      taskId: task.taskId,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      round: 1,
      taskVersion: task.taskVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      claims: [{ claim: "bounded" }],
      evidence: [{ evidence: "bounded" }],
      unresolved: [],
      createdAt: 30,
    } satisfies Omit<GovernorFaninEnvelope, "envelopeDigest">;
    const envelope: GovernorFaninEnvelope = {
      ...base,
      envelopeDigest: governorFaninEnvelopeDigest(base),
    };
    const row = bindEnvelope(envelope) as unknown as Parameters<typeof parseEnvelope>[0];
    expect(parseEnvelope(row)).toEqual(envelope);
    expect(() =>
      parseEnvelope({
        ...row,
        envelope_json: JSON.stringify({ ...envelope, claims: [{ claim: "changed" }] }),
      }),
    ).toThrow(/GOVERNOR_FANIN_ENVELOPE_BINDING_INVALID/u);
    expect(() => parseEnvelope({ ...row, task_id: createGovernorTaskId("other") })).toThrow(
      /GOVERNOR_FANIN_ENVELOPE_BINDING_INVALID/u,
    );

    const binding = {
      taskId: task.taskId,
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      round: 1,
      envelopeSetDigest: governorDigest([envelope.envelopeDigest]),
    };
    const result = { summary: "verified" };
    const digest = governorDigest({ ...binding, result });
    expect(parseReducerResult(JSON.stringify(result), digest, binding)).toEqual(result);
    expect(() =>
      parseReducerResult(JSON.stringify({ summary: "changed" }), digest, binding),
    ).toThrow(/GOVERNOR_FANIN_RESULT_DIGEST_INVALID/u);
    expect(() =>
      parseReducerResult(JSON.stringify(result), digest, { ...binding, planVersion: 1 }),
    ).toThrow(/GOVERNOR_FANIN_RESULT_DIGEST_INVALID/u);
  });

  it("preserves the original outbox payload-to-delivery-key relationship", () => {
    const task = taskFixture();
    const payload = { text: "synthetic delivery" };
    const payloadDigest = governorDigest(payload);
    const pending: GovernorOutboxRecord = {
      taskId: task.taskId,
      effectId: "effect-v24",
      deliveryKey: "",
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      leaseEpoch: task.leaseEpoch,
      executionGeneration: task.executionGeneration,
      deliveryClaimEpoch: 0,
      state: "pending",
      payload,
      payloadDigest,
      createdAt: 40,
      updatedAt: 40,
    };
    pending.deliveryKey = governorOutboxPendingDeliveryKey(pending);
    expect(governorOutboxDeliveryKey(pending)).toBe(pending.deliveryKey);
    const row = bindGovernorOutbox(pending) as unknown as Parameters<typeof parseGovernorOutbox>[0];
    expect(parseGovernorOutbox(row)).toEqual(pending);
    expect(() =>
      parseGovernorOutbox({ ...row, payload_json: JSON.stringify({ text: "changed" }) }),
    ).toThrow(/GOVERNOR_OUTBOX_BINDING_INVALID/u);
    expect(() => parseGovernorOutbox({ ...row, delivery_key: "0".repeat(64) })).toThrow(
      /GOVERNOR_OUTBOX_BINDING_INVALID/u,
    );
    expect(() =>
      parseGovernorOutbox({ ...row, payload_json: JSON.stringify({ note: "x".repeat(2 ** 21) }) }),
    ).toThrow(/GOVERNOR_OUTBOX_PAYLOAD_INVALID/u);
    expect(() =>
      parseGovernorOutbox({
        ...row,
        payload_json: JSON.stringify({ nested: { accessToken: "synthetic-secret-marker" } }),
      }),
    ).toThrow(GovernorSecretRejectedError);
  });
});
