import {
  resolveSubagentChildIntentKey,
  resolveSubagentChildSessionKey,
  resolveSubagentReservationRunId,
} from "./subagent-child-intent.js";
import {
  reserveSubagentChildIntent,
  type SubagentChildIntentReservation,
} from "./subagent-registry.js";

type SpawnChildIntentInput = {
  childIntentKey?: string;
  childSessionKey?: string;
  requesterSessionKey: string;
  targetAgentId: string;
  task: string;
  taskName?: string;
  label?: string;
  model?: string;
  modelRoute?: string;
  subagentRole: string;
  mode: "run" | "session";
  cleanup: "delete" | "keep";
  sandbox?: string;
  context?: string;
  cwd?: string;
  thread?: boolean;
  operationKey?: string;
  discriminator?: string;
  attachments?: readonly { name: string; content?: string; path?: string }[];
  thinking?: string;
  runTimeoutSeconds?: number;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachMountPath?: string;
  delivery?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  intentBehaviorDigest?: string;
  requesterDisplayKey: string;
  maxActiveChildren: number;
};

export function admitSubagentSpawnChildIntent(
  params: SpawnChildIntentInput,
): SubagentChildIntentReservation {
  const childIntentKey =
    params.childIntentKey ??
    resolveSubagentChildIntentKey({
      requesterSessionKey: params.requesterSessionKey,
      targetAgentId: params.targetAgentId,
      task: params.task,
      taskName: params.taskName,
      label: params.label,
      model: params.model,
      modelRoute: params.modelRoute,
      subagentRole: params.subagentRole,
      mode: params.mode,
      cleanup: params.cleanup,
      sandbox: params.sandbox,
      context: params.context,
      cwd: params.cwd,
      thread: params.thread,
      operationKey: params.operationKey,
      discriminator: params.discriminator,
      attachments: params.attachments,
      thinking: params.thinking,
      runTimeoutSeconds: params.runTimeoutSeconds,
      lightContext: params.lightContext,
      expectsCompletionMessage: params.expectsCompletionMessage,
      attachMountPath: params.attachMountPath,
      delivery: params.delivery,
    });
  const childSessionKey =
    params.childSessionKey ?? resolveSubagentChildSessionKey(params.targetAgentId, childIntentKey);
  return reserveSubagentChildIntent({
    childIntentKey,
    childSessionKey,
    reservationRunId: resolveSubagentReservationRunId(childIntentKey),
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    taskName: params.taskName,
    label: params.label,
    cleanup: params.cleanup,
    expectsCompletionMessage: params.expectsCompletionMessage,
    spawnMode: params.mode,
    maxActiveChildren: params.maxActiveChildren,
    intentBehaviorDigest: params.intentBehaviorDigest,
  });
}

export function resolveSubagentSpawnChildIntentKey(
  params: Omit<SpawnChildIntentInput, "requesterDisplayKey" | "maxActiveChildren">,
) {
  return resolveSubagentChildIntentKey({
    requesterSessionKey: params.requesterSessionKey,
    targetAgentId: params.targetAgentId,
    task: params.task,
    taskName: params.taskName,
    label: params.label,
    model: params.model,
    modelRoute: params.modelRoute,
    subagentRole: params.subagentRole,
    mode: params.mode,
    cleanup: params.cleanup,
    sandbox: params.sandbox,
    context: params.context,
    cwd: params.cwd,
    thread: params.thread,
    operationKey: params.operationKey,
    discriminator: params.discriminator,
    attachments: params.attachments,
    thinking: params.thinking,
    runTimeoutSeconds: params.runTimeoutSeconds,
    lightContext: params.lightContext,
    expectsCompletionMessage: params.expectsCompletionMessage,
    attachMountPath: params.attachMountPath,
    delivery: params.delivery,
  });
}

export function resolveSubagentSpawnChildSessionKey(targetAgentId: string, childIntentKey: string) {
  return resolveSubagentChildSessionKey(targetAgentId, childIntentKey);
}
