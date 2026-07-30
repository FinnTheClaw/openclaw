/**
 * sessions_spawn built-in tool.
 *
 * Starts subagent or ACP-backed sessions with inherited tool policy and delivery context.
 */
import crypto from "node:crypto";
import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../../channels/thread-bindings-policy.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagent-attachments.js";
import { finalizeSubagentCompletionGroup, registerSubagentRun } from "../subagent-registry.js";
import type { SubagentCompletionGroupState } from "../subagent-registry.types.js";
import { resolveSubagentSpawnOwnership } from "../subagent-spawn-ownership.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagent-task-name.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readStringParam,
  ToolInputError,
} from "./common.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
const UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS = [
  "runTimeoutSeconds",
  "timeoutSeconds",
] as const;
const INTERNAL_COMPLETION_GROUP_PARAM = "__completionGroup";

type AcpSpawnModule = typeof import("../acp-spawn.js");

const acpSpawnModuleLoader = createLazyImportLoader<AcpSpawnModule>(
  () => import("../acp-spawn.js"),
);

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  return await acpSpawnModuleLoader.load();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function readInternalCompletionGroup(
  params: Record<string, unknown>,
): SubagentCompletionGroupState | undefined {
  const raw = params[INTERNAL_COMPLETION_GROUP_PARAM];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.index !== "number" ||
    typeof value.expectedSize !== "number" ||
    !Number.isInteger(value.index) ||
    !Number.isInteger(value.expectedSize) ||
    value.index < 0 ||
    value.expectedSize < 1 ||
    value.expectedSize > 50
  ) {
    return undefined;
  }
  return {
    id: value.id.trim(),
    index: value.index,
    expectedSize: value.expectedSize,
    finalized: value.finalized === true,
  };
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function hasAnyThreadAvailability(availability: SessionsSpawnThreadAvailability): boolean {
  return availability.subagent || availability.acp;
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const taskDescription =
    "One bounded, independently verifiable shard with explicit scope, deliverable, and test; never the whole repository or complete parent request.";
  const taskNameDescription =
    "Stable alias for later targeting; lowercase letters/digits/underscores/hyphens, starts letter.";
  const modelDescription =
    "Optional raw model override. Prefer modelRoute so deployments can select an administrator-approved specialist; deployments may disallow raw overrides.";
  const modelRouteDescription =
    "Named specialist/capability route configured by the administrator (for example general, coding, creative, reasoning, research, vision, vision_reasoning, audio, video, or compaction). Match the task and honor an explicit user route request. Image attachments automatically prefer vision when omitted.";
  const batchTaskSchema = Type.Object({
    task: Type.String({ description: taskDescription }),
    taskName: Type.Optional(Type.String({ description: taskNameDescription })),
    label: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ description: modelDescription })),
    modelRoute: Type.Optional(Type.String({ description: modelRouteDescription })),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native context. Omit/"isolated" for clean child; "fork" only when child needs requester transcript.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: 'Light bootstrap context; runtime="subagent" only.',
      }),
    ),
  });
  const schema = {
    task: Type.Optional(Type.String({ description: taskDescription })),
    tasks: Type.Optional(
      Type.Array(batchTaskSchema, {
        minItems: 1,
        maxItems: 50,
        description:
          "Two to fifty independent native-subagent shards to admit concurrently as distinct child sessions. Use dependency waves instead of placing dependent work in the same batch.",
      }),
    ),
    taskName: Type.Optional(Type.String({ description: taskNameDescription })),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ description: modelDescription })),
    modelRoute: Type.Optional(Type.String({ description: modelRouteDescription })),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind spawn to new chat thread when supported. `thread=true` defaults mode="session".',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native context. Omit/"isolated" for clean child; "fork" only when child needs requester transcript.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: 'Light bootstrap context; runtime="subagent" only.',
      }),
    ),

    // Inline attachments (snapshot-by-value).
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.Optional(Type.String()),
          path: Type.Optional(
            Type.String({
              description:
                "Exact local staged-media path. Allowed only when local-path attachments are enabled and the resolved file is under an administrator-approved root.",
            }),
          ),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description:
                'ACP-only resume target; ignored for runtime="subagent". Use id already recorded for this requester.',
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description:
              'ACP-only stream target; ignored for runtime="subagent". Use "parent" to stream turn to requester.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    /** Separate key used only for completion routing (registerSubagentRun requesterSessionKey). */
    completionOwnerKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability(opts);
  const threadAvailable = hasAnyThreadAvailability(threadAvailability);
  const tool: AnyAgentTool = {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({ acpAvailable, threadAvailable }),
    parameters: createSessionsSpawnToolSchema({ acpAvailable, threadAvailable }),
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const unsupportedTimeoutParam = UNSUPPORTED_SESSIONS_SPAWN_TIMEOUT_PARAM_KEYS.find((key) =>
        resolveSnakeCaseParamKey(params, key),
      );
      if (unsupportedTimeoutParam) {
        const providedTimeoutParam =
          resolveSnakeCaseParamKey(params, unsupportedTimeoutParam) ?? unsupportedTimeoutParam;
        throw new ToolInputError(
          `sessions_spawn does not support per-call "${providedTimeoutParam}". Configure agents.defaults.subagents.runTimeoutSeconds instead.`,
        );
      }
      const hasSingleTask = typeof params.task === "string" && params.task.trim().length > 0;
      const hasBatchTasks = Array.isArray(params.tasks);
      if (hasSingleTask && hasBatchTasks) {
        throw new ToolInputError(
          'sessions_spawn accepts exactly one of "task" or "tasks", not both.',
        );
      }
      if (hasBatchTasks) {
        const batchTasks = params.tasks as unknown[];
        if (batchTasks.length === 0 || batchTasks.length > 50) {
          throw new ToolInputError("sessions_spawn tasks must contain between 1 and 50 shards.");
        }
        if (params.runtime === "acp") {
          throw new ToolInputError(
            'sessions_spawn tasks is for concurrent native subagents only; use individual calls for runtime="acp".',
          );
        }
        const sharedParams = { ...params };
        delete sharedParams.task;
        delete sharedParams.tasks;
        delete sharedParams.taskName;
        delete sharedParams.label;
        const completionGroupId = crypto.randomUUID();
        const batchResults: Array<Record<string, unknown>> = await Promise.all(
          batchTasks.map(async (rawTask, index): Promise<Record<string, unknown>> => {
            if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
              return {
                index,
                status: "error",
                error: `tasks[${index}] must be an object.`,
              };
            }
            const taskParams = {
              ...sharedParams,
              ...(rawTask as Record<string, unknown>),
              [INTERNAL_COMPLETION_GROUP_PARAM]: {
                id: completionGroupId,
                index,
                expectedSize: batchTasks.length,
                finalized: false,
              } satisfies SubagentCompletionGroupState,
            };
            try {
              const result = await tool.execute(`${toolCallId}:${index + 1}`, taskParams);
              const details =
                result &&
                typeof result === "object" &&
                "details" in result &&
                result.details &&
                typeof result.details === "object" &&
                !Array.isArray(result.details)
                  ? (result.details as Record<string, unknown>)
                  : { status: "error", error: "spawn returned no structured details" };
              return { index, ...details };
            } catch (err) {
              return {
                index,
                status: "error",
                error: summarizeError(err),
              };
            }
          }),
        );
        const acceptedResults = batchResults.filter((result) => result.status === "accepted");
        const firstAccepted = acceptedResults[0];
        const acceptedRunIds = acceptedResults
          .map((result) => result.runId)
          .filter((runId): runId is string => typeof runId === "string" && runId.length > 0);
        let completionAggregationError: string | undefined;
        if (acceptedRunIds.length > 0) {
          try {
            finalizeSubagentCompletionGroup({
              groupId: completionGroupId,
              acceptedRunIds,
            });
          } catch (error) {
            completionAggregationError = summarizeError(error);
          }
        }
        return jsonResult({
          // Any accepted child makes this a committed side effect. `complete`
          // and the counts tell the model whether every requested shard was admitted.
          status: acceptedResults.length > 0 ? "accepted" : "error",
          complete: acceptedResults.length === batchTasks.length,
          requestedCount: batchTasks.length,
          acceptedCount: acceptedResults.length,
          failedCount: batchTasks.length - acceptedResults.length,
          completionGroupId,
          completionAggregationReady:
            acceptedRunIds.length === acceptedResults.length && !completionAggregationError,
          ...(completionAggregationError ? { completionAggregationError } : {}),
          ...(typeof firstAccepted?.runId === "string" ? { runId: firstAccepted.runId } : {}),
          ...(typeof firstAccepted?.childSessionKey === "string"
            ? { childSessionKey: firstAccepted.childSessionKey }
            : {}),
          results: batchResults,
        });
      }
      const task = readStringParam(params, "task", { required: true });
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const modelRoute = readStringParam(params, "modelRoute");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const completionGroup = readInternalCompletionGroup(params);
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
      if (runtime === "acp" && !acpAvailable) {
        return jsonResult({
          status: "error",
          error: resolveAcpUnavailableMessage(opts),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedTool =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
          : undefined;
      if (acpUnsupportedInheritedTool) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedAllow =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
          : undefined;
      if (acpUnsupportedInheritedAllow) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
          ...roleContext,
        });
      }
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      if (runtime === "acp" && modelRoute) {
        throw new ToolInputError(
          'modelRoute is only supported for runtime="subagent"; use model for ACP sessions.',
        );
      }
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content?: string;
            path?: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        const acpAttachments = await resolveAcpSessionsSpawnImageAttachments({
          config: opts?.config ?? getRuntimeConfig(),
          attachments,
        });
        if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
          return jsonResult({
            status: acpAttachments.status,
            error: acpAttachments.error,
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
            attachments: acpAttachments?.attachments,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
            inheritedToolAllowlist: opts?.inheritedToolAllowlist,
            inheritedToolDenylist: opts?.inheritedToolDenylist,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" && Boolean(childSessionKey) && Boolean(childRunId);
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = getRuntimeConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const ownership = resolveSubagentSpawnOwnership({
            cfg,
            agentSessionKey: opts?.agentSessionKey,
            completionOwnerKey: opts?.completionOwnerKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          const shouldExpectCompletionMessage = result.inlineDelivery
            ? false
            : expectsCompletionMessage;
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              controllerSessionKey: ownership.controllerSessionKey,
              requesterSessionKey: ownership.completionRequesterSessionKey,
              requesterOrigin,
              requesterDisplayKey: ownership.completionRequesterDisplayKey,
              task,
              taskName,
              requesterAgentId: opts?.requesterAgentIdOverride,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds: result.runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      const result = await spawnSubagentDirect(
        {
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          modelRoute,
          thinking: thinkingOverrideRaw,
          cwd,
          thread,
          mode,
          cleanup,
          sandbox,
          context,
          lightContext,
          expectsCompletionMessage,
          completionGroup,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          completionOwnerKey: opts?.completionOwnerKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
        },
      );

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
  return tool;
}
