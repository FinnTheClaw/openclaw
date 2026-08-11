// Proves the integration seam is inert while disabled and proportional when explicitly enabled.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGovernorRuntimeAdapterIfEnabled } from "./runtime-adapter.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-runtime",
  channel: "synthetic",
  accountId: "account-runtime",
  conversationId: "conversation-runtime",
  sessionId: "session-runtime",
  agentId: "agent-runtime",
  workspaceId: "workspace-runtime",
};

const contract: GovernorTaskContract = {
  objective: "Inspect a synthetic runtime",
  constraints: [],
  knownFacts: [],
  unknowns: ["state"],
  completionCriteria: [
    { criterionId: "verified", description: "State is verified", mandatory: true },
  ],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

afterEach(() => closeOpenClawStateDatabase());

describe("governor runtime adapter", () => {
  it("creates no state and changes no behavior while the feature flag is off", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-runtime-off-" },
      async (state) => {
        const before = fs.readdirSync(state.stateDir).toSorted();
        expect(
          createGovernorRuntimeAdapterIfEnabled({
            env: { OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "0" },
            stateDir: state.stateDir,
            capabilities: [],
          }),
        ).toBeNull();
        expect(fs.readdirSync(state.stateDir).toSorted()).toEqual(before);
      },
    );
  });

  it("keeps quick chat direct and attaches consequential ingress to its existing flow", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-runtime-on-" },
      async (state) => {
        try {
          const adapter = createGovernorRuntimeAdapterIfEnabled({
            env: { OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1" },
            stateDir: state.stateDir,
            capabilities: [],
          });
          if (!adapter) {
            throw new Error("expected enabled governor adapter");
          }
          expect(
            adapter.routeIngress({
              sourceMessageId: "quick-1",
              sourceSequence: 1,
              scope,
              profile: {
                incident: false,
                effectful: false,
                requiresExternalEvidence: false,
                consequential: false,
                estimatedUsefulActions: 0,
                independentBranches: 0,
              },
              contract,
              now: 100,
            }),
          ).toMatchObject({
            kind: "quick",
            decision: { mode: "QUICK", toolPolicy: "forbidden" },
          });
          const governed = adapter.routeIngress({
            sourceMessageId: "focused-1",
            sourceSequence: 2,
            scope,
            profile: {
              incident: false,
              effectful: false,
              requiresExternalEvidence: true,
              consequential: true,
              estimatedUsefulActions: 3,
              independentBranches: 1,
            },
            contract,
            flowId: "flow-existing-1",
            now: 101,
          });
          expect(governed).toMatchObject({
            kind: "governed",
            decision: { mode: "FOCUSED", toolPolicy: "required" },
            task: { flowId: "flow-existing-1", state: "RECEIVED" },
          });
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
