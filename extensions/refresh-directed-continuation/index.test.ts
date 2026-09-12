import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function fixture() {
  const on = vi.fn();
  plugin.register({ on } as unknown as OpenClawPluginApi);
  const hook = (name: string) => on.mock.calls.find(([registered]) => registered === name)?.[1];
  const context = { runId: "run-1", sessionId: "shared-session" };
  const build = (prompt: string, ctx = context, messages: unknown[] = []) =>
    hook("before_prompt_build")({ prompt, messages }, ctx);
  const finalize = (reply = "I will save that.", ctx = context) =>
    hook("before_agent_finalize")(
      {
        sessionId: ctx.sessionId,
        stopHookActive: false,
        lastAssistantMessage: reply,
      },
      ctx,
    );
  const tool = (name = "read", phase = "before_tool_call", ctx = context) =>
    hook(phase)({ toolName: name, params: {}, result: "ok" }, { ...ctx, toolName: name });
  const end = (ctx = context) => hook("agent_end")({ messages: [], success: true }, ctx);
  return { build, finalize, tool, end, context };
}

const request = "Remember: keep routine status updates short, but include blockers.";

describe("directed continuation through public plugin hooks", () => {
  it.each([
    request,
    "Please remember I prefer concise routine status updates, with blockers included.",
    "Remember that I prefer short replies.",
    "Save my response length preference: concise.",
    "Update my preference to concise replies.",
    "Remove my old verbosity preference.",
    "Delete the response length preference.",
  ])("requests one native revision for zero-tool persistence: %s", (prompt) => {
    const run = fixture();
    expect(run.build(prompt)?.appendSystemContext).toContain("inspect existing state first");
    expect(run.finalize()).toMatchObject({ action: "revise" });
    expect(run.finalize()).toBeUndefined();
  });

  it("does not interpret startup memory or confident reply text as missing or completed state", () => {
    const run = fixture();
    const guidance = run.build(request, run.context, [
      { role: "system", content: "Existing preference: short status updates, include blockers." },
    ]).appendSystemContext;
    expect(guidance).toContain("do not rewrite");
    expect(guidance).toContain("actual missing change");
    const result = run.finalize("Already saved.");
    expect(result.action).toBe("revise");
    expect(result.reason).toContain("No tool operation was observed");
    expect(result.reason).toContain("does not establish that the desired memory is absent");
    expect(result.reason).toContain("without rewriting");
  });

  it.each(["read", "write", "edit", "exec"])(
    "does not retry after an observed %s call, regardless of answer wording",
    (toolName) => {
      const run = fixture();
      run.build(request);
      run.tool(toolName);
      expect(run.finalize("I will save that.")).toBeUndefined();
    },
  );

  it("recognizes after-tool evidence when the before callback was not observed", () => {
    const run = fixture();
    run.build(request);
    run.tool("read", "after_tool_call");
    expect(run.finalize()).toBeUndefined();
  });

  it("retains original intent and one-revision state across native prompt rebuilds", () => {
    const run = fixture();
    run.build(request);
    expect(run.finalize()?.action).toBe("revise");
    expect(run.build("Inspect existing state, then finish.")?.appendSystemContext).toBeTruthy();
    expect(run.finalize()).toBeUndefined();
    run.build(request);
    expect(run.finalize()).toBeUndefined();
  });

  it("retains tool observations across native prompt rebuilds", () => {
    const run = fixture();
    run.build(request);
    run.tool();
    run.build(request);
    expect(run.finalize()).toBeUndefined();
  });

  it.each([
    "Do you remember my preference?",
    "Remember my preference?",
    "Please do not remember I prefer short replies.",
    "Don't save my preference.",
    "Maybe remember I prefer short replies.",
    "Remember that I prefer short replies, perhaps.",
    '"Remember: keep updates short."',
    "'Remember: keep updates short.'",
    "> Remember: keep updates short.",
    "Example: Remember: keep updates short.",
    "Explain the example: Remember: keep updates short.",
    "Remember: keep updates short, as a quoted example.",
    "Remember: keep updates short. Do not save this.",
    "Remember to deploy the service.",
    "Please summarize the stored preferences.",
    "Save my file.",
  ])("leaves questions, negation, quotations and unsupported intents unchanged: %s", (prompt) => {
    const run = fixture();
    expect(run.build(prompt)).toBeUndefined();
    expect(run.finalize()).toBeUndefined();
  });

  it("leaves empty output to native empty-answer recovery", () => {
    const run = fixture();
    run.build(request);
    expect(run.finalize("  ")).toBeUndefined();
    expect(run.finalize("I will save that.")?.action).toBe("revise");
  });

  it("does not leak observations or revision state between runs in one session", () => {
    const run = fixture();
    run.build(request);
    run.tool();
    const next = { ...run.context, runId: "run-2" };
    run.build(request, next);
    expect(run.finalize("Plan only.", next)?.action).toBe("revise");
    expect(run.finalize()).toBeUndefined();
    run.end(next);
    run.build(request, next);
    expect(run.finalize("Plan only.", next)?.action).toBe("revise");
    run.end(next);
    run.build("What is stored?", next);
    expect(run.finalize("Here is the preference.", next)).toBeUndefined();
  });

  it("does not fall back to session identity when runId is unavailable", () => {
    const run = fixture();
    const missing = { ...run.context, runId: undefined } as unknown as typeof run.context;
    expect(run.build(request, missing)).toBeUndefined();
    expect(run.finalize("Plan only.", missing)).toBeUndefined();
  });
});
