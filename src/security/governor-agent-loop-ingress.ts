import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { createGovernorAgentLoopContract } from "./governor-agent-loop-contract.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";

export function createGovernorAgentLoopIngress(params: {
  input: GovernorAgentLoopRunInput;
  config: GovernorAgentLoopConfiguration;
  definitions: readonly GovernorCapabilityDefinition[];
  promptDigest: string;
}): Omit<Parameters<GovernorController["ingest"]>[0], "sourceSequence"> {
  const { input, config, definitions } = params;
  const contract = createGovernorAgentLoopContract({
    promptDigest: params.promptDigest,
    config,
    definitions,
  });
  return {
    sourceMessageId: input.sourceMessageId,
    scope: {
      principalId: input.principalId,
      channel: input.channel,
      accountId: input.accountId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    },
    mode: config.criteria.length > 12 ? "DEEP" : "FOCUSED",
    profile: {
      incident: false,
      effectful: definitions.some((item) => item?.mutating),
      requiresExternalEvidence: config.criteria.length > 0,
      consequential: true,
      estimatedUsefulActions: config.criteria.length,
      independentBranches: 0,
    },
    contract,
    flowId: input.runId,
    now: input.now,
  };
}
