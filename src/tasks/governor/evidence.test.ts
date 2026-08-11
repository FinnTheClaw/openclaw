// Proves evidence source identities are opaque before durable admission.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGovernorEventRecord } from "./events.js";
import { admitGovernorEvidence, createGovernorEvidenceCandidate } from "./evidence.js";
import { bindEvidence } from "./store-codec.js";
import { GovernorSqliteStore } from "./store.js";
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

describe("governor evidence identity boundary", () => {
  it("persists only an opaque source identity across restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-evidence-" },
      async (state) => {
        const rawSourceIdentity = "synthetic-evidence-source-identity";
        let store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const created = store.ingest({
          sourceMessageId: "evidence-message-1",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const candidate = createGovernorEvidenceCandidate({
          evidenceId: "evidence-1",
          taskId: created.taskId,
          criterionId: "verified",
          sourceKind: "structured_external",
          sourceIdentity: rawSourceIdentity,
          taskVersion: created.taskVersion,
          objectiveRevision: created.objectiveRevision,
          planVersion: created.planVersion,
          scopeKey: created.scopeKey,
          observedAt: 101,
          payload: { verified: true },
        });
        expect(candidate.sourceIdentity).toBe(rawSourceIdentity);
        const admission = admitGovernorEvidence({ task: created, candidate, now: 101 });
        expect(admission.admitted).toBe(true);
        if (!admission.admitted) {
          throw new Error("expected evidence admission");
        }
        const next = { ...created, taskVersion: created.taskVersion + 1, updatedAt: 101 };
        const event = createGovernorEventRecord({
          task: next,
          eventType: "evidence_admitted",
          payload: { evidenceDigest: admission.evidence.evidenceDigest },
          now: 101,
        });
        expect(
          store.commit({ current: created, next, event, evidence: [admission.evidence] }).applied,
        ).toBe(true);
        closeOpenClawStateDatabase();
        store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const persisted = store.listEvidence(created.taskId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]?.sourceIdentity).toMatch(/^oesr_[a-f0-9]{64}$/u);
        expect(JSON.stringify(persisted)).not.toContain(rawSourceIdentity);
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
        });
        const rawRows = db
          .prepare("SELECT source_identity, payload_json FROM governor_evidence")
          .all();
        expect(JSON.stringify(rawRows)).not.toContain(rawSourceIdentity);
        expect(JSON.stringify(store.loadTask(created.taskId))).not.toContain(rawSourceIdentity);
        expect(JSON.stringify(store.listEvents(created.taskId))).not.toContain(rawSourceIdentity);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects factory-bypassed raw, malformed, and semantically tampered evidence before storage", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-evidence-bypass-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        try {
          const task = store.ingest({
            sourceMessageId: "evidence-bypass-message",
            sourceSequence: 1,
            scope,
            mode: "FOCUSED",
            contract,
            now: 1,
          }).task;
          const admitted = admitGovernorEvidence({
            task,
            candidate: createGovernorEvidenceCandidate({
              evidenceId: "evidence-bypass",
              taskId: task.taskId,
              criterionId: "verified",
              sourceKind: "structured_external",
              sourceIdentity: "synthetic-external-source",
              taskVersion: task.taskVersion,
              objectiveRevision: task.objectiveRevision,
              planVersion: task.planVersion,
              scopeKey: task.scopeKey,
              observedAt: 2,
              payload: { verified: true },
            }),
            now: 2,
          });
          if (!admitted.admitted) {
            throw new Error("expected evidence admission");
          }
          expect(() =>
            bindEvidence({ ...admitted.evidence, sourceIdentity: "raw-source" as never }),
          ).toThrow(/opaque keyed reference/u);
          expect(() =>
            bindEvidence({ ...admitted.evidence, sourceIdentity: "oesr_not-a-hmac" as never }),
          ).toThrow(/opaque keyed reference/u);
          expect(() =>
            bindEvidence({ ...admitted.evidence, semanticDigest: "0".repeat(64) }),
          ).toThrow(/(semantic digest mismatch|admission signature is invalid)/u);
          const next = { ...task, taskVersion: task.taskVersion + 1, updatedAt: 3 };
          const event = createGovernorEventRecord({
            task: next,
            eventType: "evidence_admitted",
            payload: { evidenceDigest: admitted.evidence.evidenceDigest },
            now: 3,
          });
          expect(() =>
            store.commit({
              current: task,
              next,
              event,
              evidence: [{ ...admitted.evidence, admissionSignature: "0".repeat(64) }],
            }),
          ).toThrow(/admission signature is invalid/u);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
