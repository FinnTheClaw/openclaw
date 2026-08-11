import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGovernorEventRecord } from "./events.js";
import { GovernorResourceGuardError } from "./resource-guard.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-ingress",
  channel: "synthetic",
  accountId: "account-ingress",
  conversationId: "conversation-ingress",
  sessionId: "session-ingress",
  agentId: "agent-ingress",
  workspaceId: "workspace-ingress",
};

const contract: GovernorTaskContract = {
  objective: "Bounded ingress",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [
    { criterionId: "accepted", description: "Ingress is accepted", mandatory: true },
  ],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

afterEach(() => closeOpenClawStateDatabase());

describe("governor task ingress resource boundary", () => {
  it("rejects a 2 MiB objective before writing task or event rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-resource-ingress-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        expect(() =>
          store.ingest({
            sourceMessageId: "ingress-resource-test",
            sourceSequence: 1,
            scope,
            mode: "FOCUSED",
            contract: { ...contract, objective: "x".repeat(2 * 1024 * 1024) },
            now: 100,
          }),
        ).toThrow(GovernorResourceGuardError);

        const { db } = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 0,
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_events").get()).toEqual({
          count: 0,
        });
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects a caller-constructed raw flow identity before committing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-flow-ingress-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const current = store.ingest({
          sourceMessageId: "flow-resource-test",
          sourceSequence: 1,
          scope,
          mode: "FOCUSED",
          contract,
          now: 100,
        }).task;
        const rawFlowId = "raw-caller-flow-identity";
        const next = {
          ...current,
          flowId: rawFlowId,
          taskVersion: current.taskVersion + 1,
          updatedAt: 101,
        };
        const event = createGovernorEventRecord({
          task: next,
          eventType: "state_transitioned",
          payload: { reason: "synthetic" },
          now: 101,
        });

        expect(() => store.commit({ current, next, event })).toThrow(
          /Invalid governor commit envelope/u,
        );
        expect(store.loadTask(current.taskId)?.flowId).toBeUndefined();

        const { db } = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        });
        expect(JSON.stringify(db.prepare("SELECT * FROM governor_tasks").all())).not.toContain(
          rawFlowId,
        );
        closeOpenClawStateDatabase();
      },
    );
  });
});
