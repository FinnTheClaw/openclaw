/**
 * sessions_yield built-in tool.
 *
 * Ends the current turn after subagent spawning so completion events can resume the session later.
 */
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

/** Return the fail-closed reason when a session has no descendant work to await. */
export function resolveSessionsYieldPendingDescendantError(
  pendingDescendantCount: number,
): string | null {
  if (pendingDescendantCount > 0) {
    return null;
  }
  return (
    "sessions_yield requires at least one pending descendant subagent. " +
    "This session has no descendant work to wait for; continue the assigned task now " +
    "and return its verified result."
  );
}

/** Creates the sessions_yield tool for runtimes that support yield callbacks. */
export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  validateYield?: () => Promise<string | null> | string | null;
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description: "End current turn. Use after spawning subagents; results arrive as next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message") || "Turn yielded.";
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      if (!opts.validateYield) {
        return jsonResult({
          status: "error",
          error: "Yield admission is unavailable in this context",
        });
      }
      const validationError = await opts.validateYield();
      if (validationError) {
        return jsonResult({ status: "error", error: validationError });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}
