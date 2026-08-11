import { describe, expect, it } from "vitest";
import { assertValidGovernorContract, assertValidGovernorPlan } from "./contracts.js";
import { GovernorResourceGuardError } from "./resource-guard.js";
import {
  createGovernorIdentityContext,
  createGovernorTaskProjection,
  type GovernorTaskContract,
  type GovernorTaskScope,
} from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-contract",
  channel: "synthetic",
  accountId: "account-contract",
  conversationId: "conversation-contract",
  sessionId: "session-contract",
  agentId: "agent-contract",
  workspaceId: "workspace-contract",
};

const contract: GovernorTaskContract = {
  objective: "Validate a bounded contract",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [
    { criterionId: "bounded", description: "The contract is bounded", mandatory: true },
  ],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

describe("governor contract resource boundaries", () => {
  it("rejects the exact oversized objective before semantic validation", () => {
    const oversized = { ...contract, objective: "x".repeat(2 * 1024 * 1024) };
    expect(() => assertValidGovernorContract(oversized)).toThrow(GovernorResourceGuardError);
  });

  it("bounds plans before traversing dependency semantics", () => {
    const plan = {
      kind: "ordered" as const,
      steps: [
        {
          stepId: "step-1",
          description: "bounded",
          criterionIds: ["bounded"],
          dependsOn: [],
        },
      ],
    };
    assertValidGovernorPlan(plan, contract);
    expect(() =>
      assertValidGovernorPlan(
        { ...plan, steps: [{ ...plan.steps[0], description: "x".repeat(2 * 1024 * 1024) }] },
        contract,
      ),
    ).toThrow(GovernorResourceGuardError);
  });

  it("stores flow identifiers as stable keyed opaque references", () => {
    const firstIdentity = createGovernorIdentityContext("flow-key-a");
    const secondIdentity = createGovernorIdentityContext("flow-key-b");
    const create = (identity: typeof firstIdentity) =>
      createGovernorTaskProjection({
        scope,
        mode: "FOCUSED",
        contract,
        flowId: "raw-flow-marker",
        authenticatedSourceSequence: 1,
        now: 100,
        identity,
      });
    const first = create(firstIdentity);
    expect(first.flowId).toBe(firstIdentity.opaqueReference("flow-id", "raw-flow-marker"));
    expect(first.flowId).not.toContain("raw-flow-marker");
    expect(create(firstIdentity).flowId).toBe(first.flowId);
    expect(create(secondIdentity).flowId).not.toBe(first.flowId);
  });
});
