import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
assert(target, "usage: recovered-cli-usage-errors.test.mjs <openclaw-package>");

const mutationPath = path.join(target, "dist", "tool-mutation-BfXv6cQw.js");
const selectionPath = path.join(target, "dist", "selection-JInn13lc.js");
const mutationModule = await import(`${pathToFileURL(mutationPath).href}?test=${Date.now()}`);
const buildToolMutationState = mutationModule.t;
assert.equal(typeof buildToolMutationState, "function");

const message = "Reply with exactly: SPEED_TEST_COMPLETE. Nothing else.";
const missingTarget = buildToolMutationState("exec", {
  command: `time openclaw agent --message "${message}" --json 2>&1`,
});
const correctedTarget = buildToolMutationState("exec", {
  command: `time openclaw agent --agent finn --message "${message}" --json 2>&1 | tail -20`,
});
assert.ok(missingTarget.cliUsageRetryFingerprint);
assert.equal(
  missingTarget.cliUsageRetryFingerprint,
  correctedTarget.cliUsageRetryFingerprint,
  "adding an OpenClaw agent target must preserve the retry identity",
);

const differentRequest = buildToolMutationState("exec", {
  command: 'openclaw agent --agent finn --message "Do something else." --json',
});
assert.notEqual(
  missingTarget.cliUsageRetryFingerprint,
  differentRequest.cliUsageRetryFingerprint,
  "a different agent request must not clear the prior failure",
);
assert.equal(
  buildToolMutationState("exec", {
    command: `touch /tmp/side-effect && openclaw agent --message "${message}" --json`,
  }).cliUsageRetryFingerprint,
  undefined,
  "compound shell commands must fail closed",
);

const selection = fs.readFileSync(selectionPath, "utf8");
for (const marker of [
  "function isRecoverableCliUsageError(error)",
  "ctx.state.lastToolError.cliUsageRetryFingerprint",
  "recoveredCorrectedCliUsage",
  "isSameToolMutationAction(ctx.state.lastToolError, successfulAction) || recoveredCorrectedCliUsage",
]) {
  assert.ok(selection.includes(marker), `missing compiled recovery marker: ${marker}`);
}

console.log("recovered CLI usage error regression passed");
