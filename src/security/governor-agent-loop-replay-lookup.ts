import type { GovernorController } from "../tasks/governor/controller.js";
import {
  canonicalGovernorScopeKey,
  createGovernorTaskId,
  opaqueGovernorReference,
  type GovernorTaskId,
} from "../tasks/governor/types.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";

export type GovernorAgentLoopReplayHost = Readonly<{
  config: GovernorAgentLoopConfiguration;
  controller: GovernorController;
}>;

export function isSelectedGovernorAgentLoopScope(
  host: GovernorAgentLoopReplayHost,
  input: GovernorAgentLoopRunInput,
): boolean {
  return host.config.scopes.some(
    (scope) =>
      scope.sessionKey === input.sessionKey && (!scope.agentId || scope.agentId === input.agentId),
  );
}

export function resolveCompletedGovernorIngressTask(
  host: GovernorAgentLoopReplayHost,
  input: GovernorAgentLoopRunInput,
): GovernorTaskId | undefined {
  const identity = host.controller.store.identity;
  const scope = {
    principalId: input.principalId,
    channel: input.channel,
    accountId: input.accountId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  };
  const scopeKey = canonicalGovernorScopeKey(scope, identity);
  const sourceMessageId = opaqueGovernorReference(
    `source-message:${scopeKey}`,
    input.sourceMessageId,
    identity,
  );
  const taskId = createGovernorTaskId(
    opaqueGovernorReference(
      "task-ingress",
      JSON.stringify({ scope, sourceMessageId: input.sourceMessageId }),
      identity,
    ),
  );
  const task = host.controller.store.loadTask(taskId);
  if (
    !task ||
    task.state !== "COMPLETED" ||
    !host.controller.store
      .listEvents(taskId)
      .some((event) => event.scopeKey === scopeKey && event.sourceMessageId === sourceMessageId)
  ) {
    return undefined;
  }
  return taskId;
}
