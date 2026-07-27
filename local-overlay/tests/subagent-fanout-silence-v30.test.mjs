import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node subagent-fanout-silence-v30.test.mjs <openclaw-dir>");
}

const packageVersion = JSON.parse(fs.readFileSync(`${target}/package.json`, "utf8")).version;
assert.equal(packageVersion, "2026.7.1-2");

const systemPrompt = fs.readFileSync(
  path.join(target, "dist", "subagent-system-prompt-Bs91RWap.js"),
  "utf8",
);
const tools = fs.readFileSync(
  path.join(target, "dist", "openclaw-tools-KulZ1cdH.js"),
  "utf8",
);

for (const source of [systemPrompt, tools]) {
  assert.match(
    source,
    /Continue spawning every worker explicitly requested by the user before yielding or finalizing\./,
  );
  assert.match(
    source,
    /Never emit NO_REPLY on the original direct user turn, immediately after spawn acceptance, while requested children remain unspawned, or while required work is unfinished\./,
  );
  assert.match(
    source,
    /NO_REPLY is reserved only for a later completion-event turn after a visible final answer was already delivered\./,
  );
  assert.doesNotMatch(
    source,
    /If a child completion event arrives AFTER (?:you already sent )?your final answer, reply ONLY with NO_REPLY\./,
  );
}

console.log("subagent fanout silence v30 regression: PASS");
