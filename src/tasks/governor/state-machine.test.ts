// Verifies the closed behavior-governor lifecycle and stale-worker fences.
import { describe, expect, it } from "vitest";
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import { applyGovernorTransition, reclaimGovernorLease } from "./state-machine.js";
import {
  createGovernorIdentityContext,
  createGovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

const identity = createGovernorIdentityContext("synthetic-state-machine-key");

const scope: GovernorTaskScope = {
  principalId: "principal-a",
  channel: "synthetic",
  accountId: "account-a",
  conversationId: "conversation-a",
  sessionId: "session-a",
  agentId: "agent-a",
  workspaceId: "workspace-a",
};

function task() {
  return createGovernorTaskProjection({
    scope,
    mode: "DEEP",
    authenticatedSourceSequence: 1,
    now: 100,
    identity,
    contract: {
      objective: "Prove a synthetic workflow",
      constraints: [],
      knownFacts: [],
      unknowns: ["current state"],
      completionCriteria: [
        { criterionId: "criterion-1", description: "State is verified", mandatory: true },
      ],
      authority: {
        allowReadOnlyDiscovery: true,
        mutationCapabilities: [],
        canonicalTargets: [],
      },
    },
  });
}

describe("behavior governor state machine", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(isBehaviorGovernorEnabled({})).toBe(false);
    expect(isBehaviorGovernorEnabled({ OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "0" })).toBe(false);
    expect(isBehaviorGovernorEnabled({ OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "true" })).toBe(
      true,
    );
  });

  it("applies the canonical lifecycle with monotonic versions", () => {
    let current = task();
    const states = [
      "CONTRACTING",
      "PLANNING",
      "READY",
      "EXECUTING",
      "VERIFYING",
      "FINISH_CANDIDATE",
      "COMPLETED",
    ] as const;
    for (const [index, state] of states.entries()) {
      const result = applyGovernorTransition({
        task: current,
        expectedTaskVersion: current.taskVersion,
        expectedLeaseEpoch: current.leaseEpoch,
        to: state,
        now: 101 + index,
      });
      expect(result.applied).toBe(true);
      if (!result.applied) {
        throw new Error(result.reason);
      }
      current = result.task;
    }
    expect(current).toMatchObject({
      state: "COMPLETED",
      taskVersion: states.length,
      terminalAt: 107,
    });
  });

  it("fails closed for invalid transitions and stale task versions", () => {
    const current = task();
    expect(
      applyGovernorTransition({
        task: current,
        expectedTaskVersion: 99,
        expectedLeaseEpoch: 0,
        to: "CONTRACTING",
        now: 101,
      }),
    ).toMatchObject({ applied: false, reason: "task_version_conflict" });
    expect(
      applyGovernorTransition({
        task: current,
        expectedTaskVersion: 0,
        expectedLeaseEpoch: 0,
        to: "COMPLETED",
        now: 101,
      }),
    ).toMatchObject({ applied: false, reason: "invalid_transition" });
  });

  it("invalidates a stale worker after lease takeover", () => {
    const original = task();
    const reclaimed = reclaimGovernorLease({
      task: original,
      expectedTaskVersion: 0,
      expectedLeaseEpoch: 0,
      now: 101,
    });
    expect(reclaimed.applied).toBe(true);
    if (!reclaimed.applied) {
      throw new Error(reclaimed.reason);
    }
    expect(reclaimed.task).toMatchObject({
      taskVersion: 1,
      leaseEpoch: 1,
      executionGeneration: 1,
    });
    expect(
      applyGovernorTransition({
        task: reclaimed.task,
        expectedTaskVersion: 1,
        expectedLeaseEpoch: 0,
        to: "CONTRACTING",
        now: 102,
      }),
    ).toMatchObject({ applied: false, reason: "lease_epoch_conflict" });
  });
});
