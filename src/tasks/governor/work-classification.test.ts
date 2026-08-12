import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { GovernorController } from "./controller.js";
import { createGovernorEventRecord } from "./events.js";
import { GovernorRuntimeAdapter } from "./runtime-adapter.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";
import { classifyGovernorRequest } from "./work-classification.js";

const scope: GovernorTaskScope = {
  principalId: "principal-classification",
  channel: "synthetic",
  accountId: "account-classification",
  conversationId: "conversation-classification",
  sessionId: "session-classification",
  agentId: "agent-classification",
  workspaceId: "workspace-classification",
};

const callerQuick = {
  incident: false,
  effectful: false,
  requiresExternalEvidence: false,
  consequential: false,
  estimatedUsefulActions: 0,
  independentBranches: 0,
} as const;

const capabilities: GovernorCapabilityDefinition[] = [
  "fixture.write",
  "message.send",
  "memory.write",
  "child.spawn",
  "fanout.spawn",
].map((capability) => ({
  capability,
  version: "1",
  sourceRank: "structured_exact",
  mutating: true,
  canonicalTargetPrefixes: ["fixture://"],
  requiresApproval: capability !== "memory.write",
}));

function contract(
  params: {
    capability?: string;
    externalEvidence?: boolean;
    consequential?: boolean;
  } = {},
): GovernorTaskContract {
  return {
    objective: "Classify a synthetic request",
    constraints: [],
    knownFacts: params.externalEvidence ? [] : ["The answer is prompt-contained"],
    unknowns: params.externalEvidence ? ["external state"] : [],
    completionCriteria: params.consequential
      ? [{ criterionId: "verified", description: "Verify the result", mandatory: true }]
      : [],
    authority: {
      allowReadOnlyDiscovery: params.externalEvidence ?? false,
      mutationCapabilities: params.capability ? [params.capability] : [],
      canonicalTargets: params.capability ? ["fixture://target"] : [],
    },
  };
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor host-derived work classification", () => {
  it("does not let a caller understate effectful or durable work as QUICK", () => {
    const registry = new GovernorCapabilityRegistry(capabilities);
    const cases = [
      contract({ capability: "fixture.write" }),
      contract({ capability: "message.send" }),
      contract({ capability: "memory.write" }),
      contract({ capability: "child.spawn" }),
      contract({ capability: "fanout.spawn" }),
      contract({ capability: "unknown.capability" }),
      contract({ externalEvidence: true }),
      contract({ consequential: true }),
    ];
    for (const candidate of cases) {
      const decision = classifyGovernorRequest({
        contract: candidate,
        capabilities: registry,
        profile: callerQuick,
        requestedMode: "QUICK",
      });
      expect(decision.mode).not.toBe("QUICK");
      expect(decision.requiresContract).toBe(true);
      expect(decision.requiresPlan).toBe(true);
    }
    expect(
      classifyGovernorRequest({
        contract: contract({ externalEvidence: true }),
        capabilities: registry,
        profile: callerQuick,
      }),
    ).toMatchObject({ mode: "FOCUSED", toolPolicy: "required" });
  });

  it("keeps genuinely prompt-contained local conversation QUICK", () => {
    expect(
      classifyGovernorRequest({
        contract: contract(),
        capabilities: new GovernorCapabilityRegistry(capabilities),
        profile: callerQuick,
      }),
    ).toMatchObject({
      mode: "QUICK",
      requiresContract: false,
      requiresPlan: false,
      toolPolicy: "forbidden",
    });
  });

  it("rederives classification at ingress and rejects a later contract swap", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-classification-" },
      async (state) => {
        const registry = new GovernorCapabilityRegistry(capabilities);
        const store = new GovernorSqliteStore({ stateDir: state.stateDir, capabilities: registry });
        const controller = new GovernorController(store, registry);
        const adapter = new GovernorRuntimeAdapter(controller);
        const routed = adapter.routeIngress({
          sourceMessageId: "classification-effectful",
          sourceSequence: 1,
          scope,
          profile: callerQuick,
          contract: contract({ capability: "fixture.write" }),
          now: 100,
        });
        expect(routed).toMatchObject({ kind: "governed", decision: { mode: "FOCUSED" } });
        if (routed.kind !== "governed") {
          throw new Error("expected governed classification fixture");
        }
        expect(routed.task.classification?.contractDigest).toMatch(/^[a-f0-9]{64}$/u);

        const swapped = {
          ...routed.task,
          contract: contract(),
          taskVersion: routed.task.taskVersion + 1,
          updatedAt: 101,
        };
        const event = createGovernorEventRecord({
          task: swapped,
          eventType: "checkpoint_recorded",
          payload: { kind: "classification-swap" },
          now: 101,
        });
        expect(() => store.commit({ current: routed.task, next: swapped, event })).toThrow(
          /CLASSIFICATION/u,
        );
      },
    );
  });

  it("rejects persisted decisions after host capability policy changes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v26-classification-policy-" },
      async (state) => {
        const initial = new GovernorCapabilityRegistry(capabilities);
        const store = new GovernorSqliteStore({ stateDir: state.stateDir, capabilities: initial });
        store.ingest({
          sourceMessageId: "classification-policy",
          sourceSequence: 1,
          scope,
          profile: callerQuick,
          contract: contract({ capability: "fixture.write" }),
          now: 100,
        });
        closeOpenClawStateDatabase();
        const changed = new GovernorCapabilityRegistry(
          capabilities.map((item) =>
            item.capability === "fixture.write" ? Object.assign({}, item, { version: "2" }) : item,
          ),
        );
        expect(
          () => new GovernorSqliteStore({ stateDir: state.stateDir, capabilities: changed }),
        ).toThrow(/CLASSIFICATION_INVALID/u);
      },
    );
  });
});
