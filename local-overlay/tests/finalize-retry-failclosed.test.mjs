import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node finalize-retry-failclosed.test.mjs <openclaw-dir>");
}

const packageVersion = JSON.parse(fs.readFileSync(`${target}/package.json`, "utf8")).version;
assert.equal(
  packageVersion,
  "2026.7.1-2",
  `finalize fail-closed regression expects OpenClaw 2026.7.1-2, got ${packageVersion}`,
);

const readDist = (file) => fs.readFileSync(path.join(target, "dist", file), "utf8");
const processRegistry = readDist("bash-process-registry-17q1dHVV.js");
const embedded = readDist("embedded-agent-DGUuxGR2.js");
const lifecycle = readDist("lifecycle-hook-helpers-BwL6869q.js");
const selection = readDist("selection-JInn13lc.js");

assert.match(processRegistry, /session\.status = status/);
assert.match(
  processRegistry,
  /if \(session\.exited\) \{\s*moveToFinished\(session, session\.status \?\? "failed"\)/,
  "an exec process that exits while yielding must remain pollable",
);
assert.doesNotMatch(
  processRegistry,
  /activeBackgroundExecSessionIds/,
  "the frozen registry has no activeBackgroundExecSessionIds declaration and must not reference it",
);
const processRegistryModule = await import(
  `${pathToFileURL(path.join(target, "dist", "bash-process-registry-17q1dHVV.js")).href}?wedge-regression=${Date.now()}`
);
const runningSession = { id: "wedge-regression", backgrounded: false, exited: false };
assert.doesNotThrow(
  () => processRegistryModule.u(runningSession),
  "markBackgrounded must not crash the gateway for a running exec",
);
assert.equal(runningSession.backgrounded, true);

assert.match(lifecycle, /action: "exhausted"/);
assert.match(lifecycle, /exhaustedReason \?\?= reason \?\? retryInstruction/);
assert.doesNotMatch(
  lifecycle,
  /if \(nextCount > maxAttempts\) continue/,
  "exhausted hook metadata must not be normalized to ordinary continuation",
);

assert.match(selection, /outcome\.action !== "revise" && outcome\.action !== "exhausted"/);
assert.match(
  selection,
  /before_agent_finalize retry metadata exhausted; refusing unfinished success/,
);
assert.match(selection, /return \{ suppressTerminalDelivery: true \}/);
assert.doesNotMatch(
  selection,
  /revision limit reached; finalizing/,
  "the attempt layer must not accept unfinished output when revisions are exhausted",
);

assert.match(embedded, /MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 5/);
assert.match(embedded, /before_agent_finalize revisions exhausted/);
assert.match(embedded, /kind: "incomplete_turn"/);
assert.match(
  embedded,
  /The unfinished turn was not accepted as success; completed tool actions were preserved\./,
);

const pluginPath = process.env.OPENCLAW_DEBUG_HOOKS_FILE;
if (pluginPath) {
  assert.ok(fs.existsSync(pluginPath), `debug hook candidate does not exist: ${pluginPath}`);
  const plugin = fs.readFileSync(pluginPath, "utf8");
  assert.match(plugin, /AGENT_DEBUG_HOOK_REVISION = "turn-integrity-v29"/);
  assert.match(plugin, /const shouldRevise = behaviorIssues\.length > 0/);
  assert.match(plugin, /Math\.min\(5, Math\.floor\(configuredMaxRevisions\)\)/);
  assert.doesNotMatch(
    plugin,
    /behaviorIssues\.length > 0 && revisionAttempts < maxRevisionAttempts/,
    "the plugin must keep reporting unfinished output while core owns the retry budget",
  );
}

console.log("finalize retry fail-closed regression: PASS");
