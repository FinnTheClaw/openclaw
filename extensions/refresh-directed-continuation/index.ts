import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

type RunObservation = { requested: boolean; toolObserved: boolean; revisionRequested: boolean };

const GUIDANCE = [
  "For this explicit memory request, inspect existing state first.",
  "Preserve every already-satisfied part; if the requested preference already exists,",
  "report that no change was needed and do not rewrite it.",
  "Perform only the actual missing change, then use available evidence to describe the outcome.",
  "An intention is not persistence. If you cannot establish or complete the requested state,",
  "report what remains unresolved. Do not repeat completed effects.",
].join(" ");

const REVISION = [
  "No tool operation was observed during this run for the explicit memory request.",
  "This does not establish that the desired memory is absent: startup context may already contain it.",
  "Inspect existing state using available evidence and tools; preserve already-satisfied parts",
  "and perform only the missing change. If already satisfied, explain that no change was needed",
  "without rewriting. If unable to establish or complete it, report the unresolved limitation.",
  "Do not merely repeat a plan, and do not duplicate completed effects.",
].join(" ");

function hasExplicitPreferenceRequest(prompt: string): boolean {
  const text = prompt.trim();
  // Deliberately narrow intent signal, never an inference about task success.
  // Questions, examples, quoted commands and tentative discussion pass unchanged.
  if (
    /[?\n\r]/u.test(text) ||
    /^(?:["'“‘`>]|example\b|e\.g\.)/iu.test(text) ||
    /\b(?:do\s+not|don['’]t|never|not\s+yet|maybe|perhaps|might|hypothetically|example|quote|suppose|consider)\b/iu.test(
      text,
    )
  )
    return false;
  return (
    /^(?:please\s+)?remember\s*(?::\s*(?:keep|use|include|avoid|prefer)\b|(?:that\s+)?(?:i\s+prefer\b|my\s+preference\b))/iu.test(
      text,
    ) ||
    /^(?:please\s+)?(?:save|update|remove|delete)\s+(?:my|the)\s+(?:[\w-]+\s+){0,4}preferences?\b/iu.test(
      text,
    )
  );
}

export default {
  id: "refresh-directed-continuation",
  name: "Refresh Directed Continuation",
  description: "One evidence-directed native revision for explicit zero-tool memory requests.",
  register(api: OpenClawPluginApi) {
    const runs = new Map<string, RunObservation>();
    api.on("before_prompt_build", (event, ctx) => {
      if (!ctx.runId) return;
      // Native finalization revisions rebuild prompts with the same runId and
      // suppress agent_end; keep the original intent and all tool observations.
      let state = runs.get(ctx.runId);
      if (!state) {
        state = {
          requested: hasExplicitPreferenceRequest(event.prompt),
          toolObserved: false,
          revisionRequested: false,
        };
        runs.set(ctx.runId, state);
      }
      return state.requested ? { appendSystemContext: GUIDANCE } : undefined;
    });
    api.on("before_tool_call", (_event, ctx) => {
      const state = ctx.runId ? runs.get(ctx.runId) : undefined;
      if (state) state.toolObserved = true;
    });
    api.on("after_tool_call", (_event, ctx) => {
      const state = ctx.runId ? runs.get(ctx.runId) : undefined;
      if (state) state.toolObserved = true;
    });
    api.on("before_agent_finalize", (event, ctx) => {
      const state = ctx.runId ? runs.get(ctx.runId) : undefined;
      if (
        !state?.requested ||
        state.toolObserved ||
        state.revisionRequested ||
        !event.lastAssistantMessage?.trim()
      )
        return;
      state.revisionRequested = true;
      return { action: "revise", reason: REVISION };
    });
    api.on("agent_end", (_event, ctx) => {
      if (ctx.runId) runs.delete(ctx.runId);
    });
  },
} satisfies OpenClawPluginDefinition;
