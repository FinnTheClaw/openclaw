/**
 * Host-owned identity for one logical child operation.
 *
 * Provider tool-call ids and gateway run ids are execution identities. They
 * change on retries and therefore cannot provide exactly-once admission. This
 * digest binds the parent session and the normalized child operation without
 * persisting the task text or any caller-controlled identifier.
 */
import crypto from "node:crypto";

export type SubagentChildIntentInput = {
  requesterSessionKey: string;
  targetAgentId: string;
  task: string;
  taskName?: string;
  label?: string;
  model?: string;
  modelRoute?: string;
  subagentRole?: string;
  mode?: string;
  cleanup?: string;
  sandbox?: string;
  context?: string;
  cwd?: string;
  thread?: boolean;
  operationKey?: string;
  discriminator?: string;
  attachments?: readonly {
    name: string;
    content?: string;
    path?: string;
    encoding?: string;
    mimeType?: string;
  }[];
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
};

function digestValue(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function attachmentDigest(
  attachment: NonNullable<SubagentChildIntentInput["attachments"]>[number],
): string {
  return digestValue({
    name: attachment.name.trim(),
    content: typeof attachment.content === "string" ? digestValue(attachment.content) : undefined,
    path: typeof attachment.path === "string" ? digestValue(attachment.path) : undefined,
    encoding: attachment.encoding,
    mimeType: attachment.mimeType,
  });
}

export function resolveSubagentChildIntentKey(input: SubagentChildIntentInput): string {
  const operationKey = input.operationKey?.trim();
  if (operationKey) {
    return `child_op_${digestValue({
      parent: input.requesterSessionKey.trim(),
      target: input.targetAgentId.trim(),
      operationKey,
      discriminator: input.discriminator?.trim() || undefined,
    }).slice(0, 48)}`;
  }
  const canonical = {
    parent: input.requesterSessionKey.trim(),
    target: input.targetAgentId.trim(),
    task: input.task.trim(),
    taskName: input.taskName?.trim() || undefined,
    label: input.label?.trim() || undefined,
    model: input.model?.trim() || undefined,
    modelRoute: input.modelRoute?.trim() || undefined,
    role: input.subagentRole?.trim() || undefined,
    mode: input.mode?.trim() || undefined,
    cleanup: input.cleanup?.trim() || undefined,
    sandbox: input.sandbox?.trim() || undefined,
    context: input.context?.trim() || undefined,
    cwd: input.cwd?.trim() || undefined,
    thread: input.thread === true,
    discriminator: input.discriminator?.trim() || undefined,
    thinking: input.thinking?.trim() || undefined,
    runTimeoutSeconds:
      typeof input.runTimeoutSeconds === "number" && Number.isFinite(input.runTimeoutSeconds)
        ? input.runTimeoutSeconds
        : undefined,
    lightContext: input.lightContext === true,
    expectsCompletionMessage: input.expectsCompletionMessage !== false,
    attachMountPath: input.attachMountPath?.trim() || undefined,
    delivery: input.delivery
      ? {
          channel: input.delivery.channel?.trim() || undefined,
          accountId: input.delivery.accountId?.trim() || undefined,
          to: input.delivery.to?.trim() || undefined,
          threadId: input.delivery.threadId,
        }
      : undefined,
    attachments: (input.attachments ?? []).map(attachmentDigest),
  };
  return `child_intent_${digestValue(canonical).slice(0, 48)}`;
}

/** Binds the complete caller request separately from the no-operation identity. */
export function resolveSubagentChildIntentRequestDigest(input: SubagentChildIntentInput): string {
  return digestValue({
    parent: input.requesterSessionKey.trim(),
    target: input.targetAgentId.trim(),
    task: input.task.trim(),
    taskName: input.taskName?.trim() || undefined,
    label: input.label?.trim() || undefined,
    model: input.model?.trim() || undefined,
    modelRoute: input.modelRoute?.trim() || undefined,
    role: input.subagentRole?.trim() || undefined,
    mode: input.mode,
    cleanup: input.cleanup,
    sandbox: input.sandbox?.trim() || undefined,
    context: input.context?.trim() || undefined,
    cwd: input.cwd?.trim() || undefined,
    thread: input.thread === true,
    operationKey: input.operationKey?.trim() || undefined,
    discriminator: input.discriminator?.trim() || undefined,
    attachments: (input.attachments ?? []).map(attachmentDigest),
    thinking: input.thinking?.trim() || undefined,
    runTimeoutSeconds: input.runTimeoutSeconds,
    lightContext: input.lightContext === true,
    expectsCompletionMessage: input.expectsCompletionMessage !== false,
    attachMountPath: input.attachMountPath?.trim() || undefined,
    delivery: input.delivery,
  });
}

export function resolveSubagentChildIntentBehaviorDigest(input: {
  resolvedModel?: string;
  resolvedModelRoute?: string;
  thinking?: string;
  runTimeoutSeconds: number;
  lightContext: boolean;
  expectsCompletionMessage: boolean;
  attachMountPath?: string;
  provider?: string;
  mode?: string;
  cleanup?: string;
  sandbox?: string;
  context?: string;
  role?: string;
  depth?: number;
  cwd?: string;
  workspaceDir?: string;
  bootstrapContextMode?: string;
  systemPromptDigest?: string;
  attachmentReceipt?: unknown;
  executionMetadata?: unknown;
  attachments?: NonNullable<SubagentChildIntentInput["attachments"]>;
  completionGroup?: unknown;
  delivery?: SubagentChildIntentInput["delivery"];
}): string {
  return digestValue({
    model: input.resolvedModel?.trim() || undefined,
    modelRoute: input.resolvedModelRoute?.trim() || undefined,
    thinking: input.thinking?.trim() || undefined,
    runTimeoutSeconds: input.runTimeoutSeconds,
    lightContext: input.lightContext,
    expectsCompletionMessage: input.expectsCompletionMessage,
    attachMountPath: input.attachMountPath?.trim() || undefined,
    provider: input.provider?.trim() || undefined,
    mode: input.mode?.trim() || undefined,
    cleanup: input.cleanup?.trim() || undefined,
    sandbox: input.sandbox?.trim() || undefined,
    context: input.context?.trim() || undefined,
    role: input.role?.trim() || undefined,
    depth: input.depth,
    cwd: input.cwd?.trim() || undefined,
    workspaceDir: input.workspaceDir?.trim() || undefined,
    bootstrapContextMode: input.bootstrapContextMode?.trim() || undefined,
    systemPromptDigest: input.systemPromptDigest?.trim() || undefined,
    attachmentReceipt: input.attachmentReceipt,
    executionMetadata: input.executionMetadata,
    attachments: (input.attachments ?? []).map(attachmentDigest),
    completionGroup: input.completionGroup,
    delivery: input.delivery
      ? {
          channel: input.delivery.channel?.trim() || undefined,
          accountId: input.delivery.accountId?.trim() || undefined,
          to: input.delivery.to?.trim() || undefined,
          threadId: input.delivery.threadId,
        }
      : undefined,
  });
}

export function resolveSubagentChildSessionKey(targetAgentId: string, intentKey: string): string {
  return `agent:${targetAgentId.trim()}:subagent:${intentKey.replace(/^child_intent_/, "")}`;
}

export function resolveSubagentReservationRunId(intentKey: string): string {
  return `child_reservation_${intentKey.replace(/^child_intent_/, "")}`;
}
