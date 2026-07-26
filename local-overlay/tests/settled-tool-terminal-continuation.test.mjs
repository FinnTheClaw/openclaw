import assert from "node:assert/strict";
import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node settled-tool-terminal-continuation.test.mjs <openclaw-dir>");
}

const source = fs.readFileSync(
  `${target}/dist/embedded-agent-DGUuxGR2.js`,
  "utf8",
);
const helperMatch = source.match(
  /function hasSettledTerminalToolUse\(attempt\) \{[\s\S]*?\n\}/,
);
assert.ok(helperMatch, "compiled settled-tool helper must exist");

const hasSettledTerminalToolUse = Function(
  `"use strict"; ${helperMatch[0]}; return hasSettledTerminalToolUse;`,
)();

function makeAttempt({
  ids = ["call-1"],
  completed = ids,
  failed = [],
  activeCount = 0,
  staleResults = [],
} = {}) {
  const assistant = {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "I am applying that now." },
      ...ids.map((id) => ({ type: "toolCall", id, name: "edit", arguments: {} })),
    ],
  };
  const result = (id, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    isError,
    content: isError ? "failed" : "ok",
  });
  return {
    currentAttemptAssistant: assistant,
    lastAssistant: assistant,
    itemLifecycle: {
      startedCount: ids.length,
      completedCount: completed.length + failed.length,
      activeCount,
    },
    messagesSnapshot: [
      ...staleResults.map((id) => result(id)),
      assistant,
      ...completed.map((id) => result(id)),
      ...failed.map((id) => result(id, true)),
    ],
  };
}

assert.equal(
  hasSettledTerminalToolUse(makeAttempt()),
  true,
  "visible pre-tool text plus a completed tool must continue",
);
assert.equal(
  hasSettledTerminalToolUse(makeAttempt({ completed: [] })),
  false,
  "an undispatched tool must fail closed",
);
assert.equal(
  hasSettledTerminalToolUse(makeAttempt({ completed: [], failed: ["call-1"] })),
  false,
  "a failed tool must not be described as settled",
);
assert.equal(
  hasSettledTerminalToolUse(
    makeAttempt({ ids: ["call-1", "call-2"], completed: ["call-1"] }),
  ),
  false,
  "a partially completed tool batch must fail closed",
);
assert.equal(
  hasSettledTerminalToolUse(
    makeAttempt({ ids: ["call-1"], completed: [], staleResults: ["call-1"] }),
  ),
  false,
  "a stale result before the terminal assistant must not prove completion",
);
assert.equal(
  hasSettledTerminalToolUse(makeAttempt({ activeCount: 1 })),
  false,
  "active tool work must not be finalized",
);

assert.match(source, /settledToolContinuationAttempts < 1/);
assert.match(source, /restrictToolsForNextAttempt = true;/);
assert.match(
  source,
  /restrictToolsForNextAttempt \? \["read"\] : params\.toolsAllow/,
);
assert.match(source, /suppressNextUserMessagePersistence = true;/);
assert.match(
  source,
  /nextAttemptPromptOverride = SETTLED_TOOL_TERMINAL_CONTINUATION_PROMPT;/,
);

console.log("settled tool continuation regression: PASS");
