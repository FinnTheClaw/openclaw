// Exercises the host-receipt evidence boundary with synthetic bootstrap capabilities.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGovernorEventRecord } from "./events.js";
import { createGovernorEvidenceCandidate } from "./evidence.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestBroker } from "./test-broker.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-evidence",
  channel: "synthetic",
  accountId: "account-evidence",
  conversationId: "conversation-evidence",
  sessionId: "session-evidence",
  agentId: "agent-evidence",
  workspaceId: "workspace-evidence",
};

const contract: GovernorTaskContract = {
  objective: "Verify opaque evidence sources",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [{ criterionId: "verified", description: "Verified", mandatory: true }],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

afterEach(() => closeOpenClawStateDatabase());

function candidate(params: {
  task: ReturnType<GovernorSqliteStore["ingest"]>["task"];
  sourceIdentity: string;
  payload?: { verified: boolean };
}) {
  return createGovernorEvidenceCandidate({
    evidenceId: `evidence_${params.task.taskId}`,
    taskId: params.task.taskId,
    criterionId: "verified",
    sourceKind: "structured_external",
    sourceIdentity: params.sourceIdentity,
    taskVersion: params.task.taskVersion,
    objectiveRevision: params.task.objectiveRevision,
    planVersion: params.task.planVersion,
    scopeKey: params.task.scopeKey,
    observedAt: 101,
    payload: params.payload ?? { verified: true },
  });
}

function nextEvent(task: ReturnType<GovernorSqliteStore["ingest"]>["task"]) {
  const next = { ...task, taskVersion: task.taskVersion + 1, updatedAt: 102 };
  return {
    next,
    event: createGovernorEventRecord({
      task: next,
      eventType: "evidence_admitted",
      payload: { reason: "synthetic" },
      now: 102,
    }),
  };
}

describe("governor evidence host receipt boundary", () => {
  it("persists only broker-admitted opaque evidence across restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-evidence-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const rawSourceIdentity = "synthetic-evidence-source-identity";
        let store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
        });
        const task = store.ingest({
          sourceMessageId: "evidence-message-1",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const receiptId = broker.capabilities.submitObservedReceipt({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          objectiveRevision: task.objectiveRevision,
          planVersion: task.planVersion,
          sourceKind: "structured_external",
          sourceIdentity: rawSourceIdentity,
          payload: { verified: true },
          observedAt: 101,
        });
        const admission = store.admitEvidenceCandidate({
          task,
          candidate: candidate({ task, sourceIdentity: rawSourceIdentity }),
          receiptId,
          now: 101,
        });
        const { next, event } = nextEvent(task);
        expect(
          store.commit({ current: task, next, event, evidenceAdmission: admission }).applied,
        ).toBe(true);
        closeOpenClawStateDatabase();
        store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
        });
        const persisted = store.listEvidence(task.taskId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]?.sourceIdentity).toMatch(/^oesr_[a-f0-9]{64}$/u);
        expect(JSON.stringify(persisted)).not.toContain(rawSourceIdentity);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects minted records, invented receipts, asserted-source mismatches, tampering, and stale scope", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-evidence-adversarial-" },
      async (state) => {
        const broker = createGovernorTestBroker({ stateDir: state.stateDir });
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
        });
        const task = store.ingest({
          sourceMessageId: "evidence-message-2",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const receiptId = broker.capabilities.submitObservedReceipt({
          scopeKey: task.scopeKey,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          objectiveRevision: task.objectiveRevision,
          planVersion: task.planVersion,
          sourceKind: "structured_external",
          sourceIdentity: "host-source",
          payload: { verified: true },
          observedAt: 101,
        });
        expect(() =>
          store.admitEvidenceCandidate({
            task,
            candidate: candidate({ task, sourceIdentity: "caller-asserted-source" }),
            receiptId,
            now: 101,
          }),
        ).toThrow(/does not match/u);
        expect(() =>
          store.admitEvidenceCandidate({
            task,
            candidate: candidate({ task, sourceIdentity: "host-source" }),
            receiptId: "ghr_invented",
            now: 101,
          }),
        ).toThrow(/unknown, invalid, or out of scope/u);
        const admission = store.admitEvidenceCandidate({
          task,
          candidate: candidate({ task, sourceIdentity: "host-source" }),
          receiptId,
          now: 101,
        });
        const forged = { evidence: admission.evidence } as never;
        const { next, event } = nextEvent(task);
        expect(() =>
          store.commit({ current: task, next, event, evidenceAdmission: forged }),
        ).toThrow(/GOVERNOR_EVIDENCE_ADMISSION_UNTRUSTED/u);
        expect(
          store.commit({ current: task, next, event, evidenceAdmission: admission }).applied,
        ).toBe(true);
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
        });
        db.prepare("UPDATE governor_evidence SET payload_json = ?").run('{"forged":true}');
        expect(() => store.listEvidence(task.taskId)).toThrow(
          /GOVERNOR_EVIDENCE_PAYLOAD_DIGEST_INVALID/u,
        );
        closeOpenClawStateDatabase();
      },
    );
  });
});
