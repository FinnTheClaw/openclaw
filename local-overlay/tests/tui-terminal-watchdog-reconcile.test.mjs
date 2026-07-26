import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node tui-terminal-watchdog-reconcile.test.mjs <openclaw-package-root>");
}

const bundlePath = path.join(target, "dist", "tui-ttOZNpsl.js");
const source = fs.readFileSync(bundlePath, "utf8");

assert.match(source, /setTimeout\(async \(\) => \{/);
assert.match(source, /await reconcileWatchedRunFromHistory\(runId\)/);
assert.match(source, /armStreamingWatchdog\(runId\)/);
assert.match(source, /sessionStatus: typeof sessionInfo\?\.status === "string"/);

const match = source.match(
  /const reconcileWatchedRunFromHistory = async \(runId\) => \{([\s\S]*?)\n\t\};\n\tconst finalizeRun/,
);
assert.ok(match, "could not extract reconcileWatchedRunFromHistory from TUI bundle");

const createReconciler = new Function(
  "loadHistory",
  "state",
  "chatLog",
  "noteFinalizedRun",
  "clearActiveRunIfMatch",
  "setActivityStatus",
  "clearStreamingWatchdog",
  "refreshSessionInfo",
  "tui",
  `"use strict";
  const reconcileWatchedRunFromHistory = async (runId) => {${match[1]}
  };
  return reconcileWatchedRunFromHistory;`,
);

function buildHarness(historyResult, options = {}) {
  const events = [];
  const state = {
    activeChatRunId: "run-1",
    pendingChatRunId: "run-1",
    pendingSubmitDraft: { runId: "run-1", text: "hello" },
    pendingOptimisticUserMessage: true,
  };
  const reconcile = createReconciler(
    async () => {
      if (options.activeRunAfterHistory !== undefined) {
        state.activeChatRunId = options.activeRunAfterHistory;
      }
      return historyResult;
    },
    state,
    { dismissPendingSystem: (runId) => events.push(["dismiss", runId]) },
    (runId, metadata) => events.push(["finalize", runId, metadata]),
    (runId) => {
      if (state.activeChatRunId === runId) {
        state.activeChatRunId = null;
      }
    },
    (status) => events.push(["status", status]),
    () => events.push(["clear-watchdog"]),
    () => events.push(["refresh"]),
    { requestRender: (force) => events.push(["render", force]) },
  );
  return { reconcile, state, events };
}

{
  const harness = buildHarness({
    loaded: true,
    inFlightRunId: null,
    sessionStatus: "done",
  });
  assert.equal(await harness.reconcile("run-1"), true);
  assert.equal(harness.state.activeChatRunId, null);
  assert.equal(harness.state.pendingChatRunId, null);
  assert.equal(harness.state.pendingSubmitDraft, null);
  assert.equal(harness.state.pendingOptimisticUserMessage, false);
  assert.ok(harness.events.some(([event, value]) => event === "status" && value === "idle"));
  assert.ok(harness.events.some(([event]) => event === "finalize"));
}

for (const historyResult of [
  { loaded: true, inFlightRunId: null, sessionStatus: "running" },
  { loaded: true, inFlightRunId: "run-1", sessionStatus: "done" },
  { loaded: false, inFlightRunId: null, sessionStatus: "done" },
]) {
  const harness = buildHarness(historyResult);
  assert.equal(await harness.reconcile("run-1"), false);
  assert.equal(harness.state.activeChatRunId, "run-1");
  assert.equal(harness.state.pendingChatRunId, "run-1");
  assert.equal(harness.events.some(([event]) => event === "finalize"), false);
}

{
  const harness = buildHarness(
    { loaded: true, inFlightRunId: null, sessionStatus: "done" },
    { activeRunAfterHistory: "run-2" },
  );
  assert.equal(await harness.reconcile("run-1"), true);
  assert.equal(harness.state.activeChatRunId, "run-2");
  assert.equal(harness.events.some(([event]) => event === "finalize"), false);
}

console.log("TUI terminal watchdog reconciliation regression: PASS");
