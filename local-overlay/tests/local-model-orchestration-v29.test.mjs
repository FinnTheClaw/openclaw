import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2] || "/opt/homebrew/lib/node_modules/openclaw";
const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
assert.equal(packageJson.version, "2026.7.1-2");

const toolSearch = fs.readFileSync(path.join(target, "dist/tool-search-B8B4Spes.js"), "utf8");
const selection = fs.readFileSync(path.join(target, "dist/selection-JInn13lc.js"), "utf8");

assert.match(
  toolSearch,
  /LOCAL_MODEL_LEAN_DIRECT_TOOL_NAMES[\s\S]*?"exec"[\s\S]*?"memory_get"[\s\S]*?"memory_search"[\s\S]*?"sessions_spawn"[\s\S]*?"sessions_yield"/,
  "lean local-model parents must receive durable-memory, spawn, and nonblocking-yield tools directly",
);
assert.match(selection, /## Subagent Runtime State/);
assert.match(selection, /\.\.\.list\.recent\.map/);
assert.match(selection, /scope: "recent"/);
assert.match(
  selection,
  /status=done\/failed\/timeout are settled; remember them as completed evidence and do not wait for them again/,
);

console.log("local-model orchestration v29 regression: PASS");
