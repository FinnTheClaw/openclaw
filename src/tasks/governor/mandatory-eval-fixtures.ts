// Shared deterministic fixtures for the mandatory governor evaluations.
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import type { GovernorPlan, GovernorTaskContract, GovernorTaskScope } from "./types.js";

export function mandatoryEvalScope(index: number): GovernorTaskScope {
  return {
    principalId: `principal-${index}`,
    channel: "synthetic",
    accountId: `account-${index}`,
    conversationId: `conversation-${index}`,
    sessionId: `session-${index}`,
    agentId: "agent-eval",
    workspaceId: `workspace-${index}`,
  };
}

export function mandatoryEvalContract(objective: string, mutating: boolean): GovernorTaskContract {
  return {
    objective,
    constraints: ["Use synthetic fixtures"],
    knownFacts: [],
    unknowns: ["final state"],
    completionCriteria: [
      { criterionId: "verified", description: "Final state is verified", mandatory: true },
    ],
    authority: {
      allowReadOnlyDiscovery: true,
      mutationCapabilities: mutating ? ["synthetic.mutate"] : [],
      canonicalTargets: mutating ? ["fixture://target"] : [],
    },
  };
}

export const mandatoryEvalPlan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "verify",
      description: "Produce exact synthetic evidence",
      criterionIds: ["verified"],
      dependsOn: [],
    },
  ],
};

export function createMandatoryEvalRegistry(): GovernorCapabilityRegistry {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.mutate",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
    {
      capability: "synthetic.inspect",
      version: "1",
      sourceRank: "structured_exact",
      mutating: false,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
  ]);
}
