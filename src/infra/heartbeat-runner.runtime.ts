// Lazy heartbeat runtime facade keeps tests from importing the full auto-reply
// runtime unless the runner path needs it.
import {
  loadPublishedGatewayReplyDispatchRuntime,
  preparedModelRuntimeConfigsMatch,
} from "../agents/prepared-model-runtime.js";
import { getReplyFromConfig as resolveReplyFromConfig } from "../auto-reply/reply.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { bindPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";

export async function getHeartbeatReplyFromConfig(
  ...args: Parameters<typeof resolveReplyFromConfig>
): ReturnType<typeof resolveReplyFromConfig> {
  const [ctx, opts, configOverride] = args;
  const agentId = ctx.AgentId?.trim();
  const runtime = agentId
    ? await loadPublishedGatewayReplyDispatchRuntime({
        agentId,
        abortSignal: opts?.abortSignal,
      })
    : undefined;
  if (
    runtime &&
    (!configOverride || preparedModelRuntimeConfigsMatch(runtime.config, configOverride))
  ) {
    return bindPreparedReplyDispatchRuntime(runtime, resolveReplyFromConfig)(ctx, opts);
  }
  // A distinct per-run config must win over a published snapshot. Passing it
  // through the bound call would also disable that binding inside getReplyFromConfig.
  return resolveReplyFromConfig(
    ctx,
    opts,
    runtime && configOverride ? withFullRuntimeReplyConfig(configOverride) : configOverride,
  );
}
