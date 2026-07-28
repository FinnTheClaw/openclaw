import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
assert(target, "usage: source-integrated-turn-lifecycle-v53.test.mjs <openclaw-package>");

const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
assert.equal(packageJson.finnSourceBuild?.sourceIntegrated, true);
assert.equal(packageJson.finnSourceBuild?.sourceState, "clean");
assert.equal(packageJson.finnSourceBuild?.behaviorContract, "turn-lifecycle-v53");
assert.match(packageJson.finnSourceBuild?.sourceCommit ?? "", /^[0-9a-f]{40}$/);

const dist = path.join(target, "dist");
const javascriptFiles = fs
  .readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => path.join(dist, entry.name));

function findBundle(symbol) {
  const matches = javascriptFiles.filter((file) => fs.readFileSync(file, "utf8").includes(symbol));
  assert.ok(matches.length > 0, `compiled runtime is missing structural symbol: ${symbol}`);
  return { file: matches[0], source: fs.readFileSync(matches[0], "utf8") };
}

const parentFork = findBundle("resolveParentForkMaxTokens");
for (const symbol of [
  "parentEntry.contextTokens",
  "resolveContextTokensForModel",
  "config?.agents?.defaults?.contextTokens",
]) {
  assert.ok(parentFork.source.includes(symbol), `parent-fork contract is missing: ${symbol}`);
}

const tui = findBundle("reconcileWatchedRunFromHistory");
for (const symbol of [
  "sessionStatus",
  "inFlightRunId",
  "streamingWatchdogReconcileInFlight",
  "armStreamingWatchdog(runId)",
]) {
  assert.ok(tui.source.includes(symbol), `TUI reconciliation contract is missing: ${symbol}`);
}

const embedded = findBundle("MAX_COMPLETED_TOOL_RESULT_CONTINUATIONS");
for (const symbol of [
  'kind: "incomplete_turn"',
  "completedToolResultProgress",
  "yieldDetected",
  "livenessState",
]) {
  assert.ok(embedded.source.includes(symbol), `turn lifecycle contract is missing: ${symbol}`);
}

const tools = findBundle("sessions_yield");
assert.ok(
  tools.source.includes("sessions_yield"),
  "nonblocking subagent yield must be present in the compiled tool runtime",
);

for (const bundle of [parentFork.file, tui.file, embedded.file, tools.file]) {
  const source = fs.readFileSync(bundle, "utf8");
  assert.doesNotMatch(source, /activeBackgroundExecSessionIds/);
  execFileSync(process.execPath, ["--check", bundle], { stdio: "pipe" });
}

console.log("source-integrated turn lifecycle v53 regression: PASS");
