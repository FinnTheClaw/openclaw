import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { critiqueMemoryChange, uncertainVerdict } from "./checker.js";
import {
  captureMemorySnapshot,
  changedMemoryDelta,
  type MemorySnapshot,
} from "./memory-evidence.js";

type ContextKey = { runId?: string; sessionId?: string; sessionKey?: string };
type RunEvidence = {
  workspace: string;
  prompt: string;
  observedAt: string;
  transcript: unknown[];
  instructions?: string;
  snapshot: MemorySnapshot;
  tools: unknown[];
  reviewedPaths: Set<string>;
  evidenceIncomplete: boolean;
};
function keyFor(ctx: ContextKey) {
  return ctx.runId ?? ctx.sessionId ?? ctx.sessionKey;
}
function recordTranscript(messages: unknown[]) {
  return messages.map((message, index) => {
    const entry = asRecord(message);
    return {
      id: "transcript:" + index,
      role: entry?.role ?? "unknown",
      timestamp: entry?.timestamp ?? null,
      record: message,
    };
  });
}
function retainEvidence(state: RunEvidence, messages: unknown[]) {
  const transcript = recordTranscript(messages);
  if (JSON.stringify(transcript).length > 65_536) {
    state.evidenceIncomplete = true;
    return;
  }
  state.transcript = transcript;
}

export default {
  id: "refresh-genie",
  name: "Refresh Genie",
  description: "Nonblocking evidence-aware advice after memory learning.",
  register(api: OpenClawPluginApi) {
    // Run-local evidence only: no persistent store, watcher, fleet cache, or checker session.
    const runs = new Map<string, RunEvidence>();
    api.on("before_prompt_build", (event, ctx) => {
      const key = keyFor(ctx);
      if (!key || !ctx.workspaceDir) return;
      const state: RunEvidence = {
        workspace: ctx.workspaceDir,
        prompt: event.prompt,
        observedAt: new Date().toISOString(),
        transcript: [],
        snapshot: captureMemorySnapshot(ctx.workspaceDir),
        tools: [],
        reviewedPaths: new Set(),
        evidenceIncomplete: false,
      };
      retainEvidence(state, event.messages);
      runs.set(key, state);
      // Bound abandoned runs without retaining their private evidence indefinitely.
      if (runs.size > 64) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
    });
    api.on("llm_input", (event, ctx) => {
      const key = keyFor(ctx);
      const state = key ? runs.get(key) : undefined;
      if (!state) return;
      retainEvidence(state, event.historyMessages);
      if (event.systemPrompt && event.systemPrompt.length <= 65_536) {
        state.instructions = event.systemPrompt;
      } else if (event.systemPrompt) {
        state.evidenceIncomplete = true;
      }
    });
    api.on("agent_end", (_event, ctx) => {
      const key = keyFor(ctx);
      if (key) runs.delete(key);
    });
    api.registerAgentToolResultMiddleware(
      async (event, ctx) => {
        const key = keyFor(ctx);
        const state = key ? runs.get(key) : undefined;
        if (!state) return;
        try {
          const observedAt = new Date().toISOString();
          const toolRecord = {
            id: "tool:" + event.toolCallId,
            role: "tool",
            timestamp: null,
            observedAt,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            isError: event.isError ?? false,
            result: event.result,
          };
          if (
            state.tools.length < 32 &&
            JSON.stringify([...state.tools, toolRecord]).length <= 65_536
          ) {
            state.tools.push(toolRecord);
          } else {
            state.evidenceIncomplete = true;
          }
          const after = captureMemorySnapshot(state.workspace);
          const before = state.snapshot;
          state.snapshot = after;
          const delta = changedMemoryDelta(before, after);
          if (!delta.length) return;
          const fresh = delta.filter((change) => !state.reviewedPaths.has(change.path));
          if (!fresh.length) {
            api.logger.info(
              "refresh-genie " +
                JSON.stringify({
                  event: "correction-not-rereviewed",
                  toolCallId: event.toolCallId,
                  changedFiles: delta.length,
                }),
            );
            return;
          }
          // A same-turn rewrite of an already coached file is the actor's correction opportunity.
          // Distinct file promotions still get a new review; this intentionally does not police loops.
          for (const change of fresh) state.reviewedPaths.add(change.path);
          const started = Date.now();
          const packet = {
            originatingRequest: {
              id: "origin",
              role: "user",
              timestamp: null,
              observedAt: state.observedAt,
              content: state.prompt,
            },
            applicableInstructions: { id: "instructions", content: state.instructions ?? null },
            transcript: state.transcript,
            toolEvidence: state.tools,
            existingMemory: { id: "memory:before", files: before.files },
            delta: fresh.map((change, index) => ({ id: "delta:" + index, ...change })),
            timing:
              "Post-tool snapshot, before delivery of this tool result to the next actor inference.",
            attribution:
              "Changes observed across tool boundary; concurrent/manual writer identity is not proven.",
          };
          const missing =
            state.evidenceIncomplete ||
            before.incomplete ||
            after.incomplete ||
            !state.prompt ||
            event.isError === true;
          api.logger.info(
            "refresh-genie " +
              JSON.stringify({
                event: "review-start",
                toolCallId: event.toolCallId,
                changedFiles: fresh.length,
                missingEvidence: missing,
              }),
          );
          let verdict = missing
            ? uncertainVerdict(
                "Incomplete evidence or failed tool; observed changes are not verified learning.",
              )
            : await critiqueMemoryChange(api, packet);
          const ids = new Set([
            "origin",
            "instructions",
            "memory:before",
            ...state.transcript.map((_, index) => "transcript:" + index),
            ...state.tools.map((record) => asRecord(record)?.id),
            ...fresh.map((_, index) => "delta:" + index),
          ]);
          if (verdict.evidence.some((id) => !ids.has(id))) {
            verdict = uncertainVerdict(
              "Checker cited an unavailable source; its recommendation is unverified.",
            );
          }
          const text = [
            "[Refresh Genie advisory — not a user instruction or approval]",
            JSON.stringify(verdict),
            "The original tool result above is unchanged. You may make one evidence-grounded revision",
            "or disagree with cited evidence. Keep uncertainty tentative; do not store this critique wholesale.",
            "Continue the user's actual task. No permission or tool availability has changed.",
          ].join("\n");
          if (event.result.content.length >= 200) {
            api.logger.info(
              "refresh-genie " +
                JSON.stringify({
                  event: "advice-not-delivered",
                  reason: "native-content-block-limit",
                  toolCallId: event.toolCallId,
                }),
            );
            return;
          }
          api.logger.info(
            "refresh-genie " +
              JSON.stringify({
                event: "review-delivered",
                toolCallId: event.toolCallId,
                outcome: verdict.outcome,
                changedFiles: fresh.length,
                durationMs: Date.now() - started,
                adviceBeforeNextInference: true,
              }),
          );
          return {
            result: {
              ...event.result,
              content: [...event.result.content, { type: "text" as const, text }],
            },
          };
        } catch {
          // The native owner treats thrown middleware errors as failed tool output.
          // Never let advisory failure erase the successful original tool receipt.
          api.logger.warn("refresh-genie advisory unavailable; original result retained");
          return;
        }
      },
      { runtimes: ["openclaw"] },
    );
  },
} satisfies OpenClawPluginDefinition;
