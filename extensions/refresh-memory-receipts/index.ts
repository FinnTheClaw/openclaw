import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  captureMemoryAttempt,
  memoryReceipt,
  memoryTarget,
  type MemoryAttempt,
} from "./memory-receipt.js";

type RunContext = { runId?: string; sessionId?: string; sessionKey?: string };
type RunState = { workspace: string; pending: Map<string, MemoryAttempt> };
const keyFor = (ctx: RunContext) => ctx.runId ?? ctx.sessionId ?? ctx.sessionKey;

const GUIDANCE = [
  "Memory persistence: acknowledge saved/updated memory only when a matching readback receipt",
  "supports the requested change. An intention or a reply alone is not persistence; if no tool ran,",
  "do not say it was saved. A no-op receipt means the requested bytes already existed, not a new write.",
  "A mismatch or unverified receipt is advisory, not failure of the underlying tool: inspect actual",
  "evidence, retry only the evidenced problem when appropriate, or qualify/correct the acknowledgment.",
  "Receipts cover native file writes/edits to workspace MEMORY.md, USER.md, AGENTS.md, SOUL.md and",
  "memory/*.md. Shell/apply_patch writes, special path expansion, nonlocal files, and complex",
  "edit normalization may be unverified; obtain explicit readback evidence before acknowledging them.",
  "Byte verification does not prove faithful interpretation: preserve the user's scope and uncertainty.",
  "Continue normal tasks and tools; this guidance adds no permission gate or response filter.",
].join(" ");

export default {
  id: "refresh-memory-receipts",
  name: "Refresh Memory Receipts",
  description: "Advisory native memory write/edit readback receipts.",
  register(api: OpenClawPluginApi) {
    const runs = new Map<string, RunState>();
    api.on("before_prompt_build", (_event, ctx) => {
      const key = keyFor(ctx);
      if (key && ctx.workspaceDir) {
        runs.set(key, { workspace: ctx.workspaceDir, pending: new Map() });
        if (runs.size > 64) {
          const oldest = runs.keys().next().value;
          if (oldest !== undefined) runs.delete(oldest);
        }
      }
      return { appendSystemContext: GUIDANCE };
    });
    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const key = keyFor(ctx);
      const state = key ? runs.get(key) : undefined;
      const callId = ctx.toolCallId ?? event.toolCallId;
      if (!state || !callId) return;
      try {
        const target = memoryTarget(state.workspace, event.params);
        if (!target) return;
        state.pending.set(callId, captureMemoryAttempt(state.workspace, target));
        if (state.pending.size > 64) {
          const oldest = state.pending.keys().next().value;
          if (oldest !== undefined) state.pending.delete(oldest);
        }
      } catch {
        // An advisory read must never block the native write/edit.
        state.pending.delete(callId);
      }
    });
    api.on("agent_end", (_event, ctx) => {
      const key = keyFor(ctx);
      if (key) runs.delete(key);
    });
    api.registerAgentToolResultMiddleware(
      (event, ctx) => {
        if (event.toolName !== "write" && event.toolName !== "edit") return;
        const key = keyFor(ctx);
        const state = key ? runs.get(key) : undefined;
        if (!state) return;
        const attempt = state.pending.get(event.toolCallId);
        state.pending.delete(event.toolCallId);
        try {
          const target = memoryTarget(state.workspace, event.args, event.cwd ?? state.workspace);
          if (!target || event.result.content.length >= 200) return;
          const text = memoryReceipt({
            workspace: state.workspace,
            target,
            toolName: event.toolName,
            args: event.args,
            attempt,
            isError: event.isError,
          });
          return {
            result: {
              ...event.result,
              content: [...event.result.content, { type: "text" as const, text }],
            },
          };
        } catch {
          // Throwing here would turn a successful native result into an error.
          api.logger.warn("refresh-memory-receipts unavailable; original result retained");
          return;
        }
      },
      { runtimes: ["openclaw"] },
    );
  },
} satisfies OpenClawPluginDefinition;
