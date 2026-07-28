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
  /(function resolveSettledTerminalToolProgress\(attempt\) \{[\s\S]*?\n\})\nfunction hasSettledTerminalToolUse/,
);
assert.ok(helperMatch, "compiled progress-aware settled-tool helper must exist");

const resolveSettledTerminalToolProgress = Function(
  `"use strict"; ${helperMatch[1]}; return resolveSettledTerminalToolProgress;`,
)();

function makeAttempt({
  ids = ["call-1"],
  completed = ids,
  failed = [],
  activeCount = 0,
  staleResults = [],
  terminalAssistant = {
    role: "assistant",
    stopReason: "stop",
    content: [],
  },
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
    currentAttemptAssistant: terminalAssistant,
    lastAssistant: terminalAssistant,
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
      terminalAssistant,
    ],
  };
}

assert.deepEqual(
  resolveSettledTerminalToolProgress(makeAttempt()),
  { key: "call-1", completedCount: 1 },
  "an empty assistant after a completed tool must recover the prior progress",
);
assert.equal(
  resolveSettledTerminalToolProgress(makeAttempt({ completed: [] })),
  null,
  "an undispatched tool must fail closed",
);
assert.equal(
  resolveSettledTerminalToolProgress(
    makeAttempt({ completed: [], failed: ["call-1"] }),
  ),
  null,
  "a failed tool must not be described as settled",
);
assert.equal(
  resolveSettledTerminalToolProgress(
    makeAttempt({ ids: ["call-1", "call-2"], completed: ["call-1"] }),
  ),
  null,
  "a partially completed tool batch must fail closed",
);
assert.equal(
  resolveSettledTerminalToolProgress(
    makeAttempt({ ids: ["call-1"], completed: [], staleResults: ["call-1"] }),
  ),
  null,
  "a stale result before the terminal assistant must not prove completion",
);
assert.equal(
  resolveSettledTerminalToolProgress(makeAttempt({ activeCount: 1 })),
  null,
  "active tool work must not be finalized",
);
assert.deepEqual(
  resolveSettledTerminalToolProgress(makeAttempt({ ids: ["call-2"] })),
  { key: "call-2", completedCount: 1 },
  "a newly completed tool call must produce a new progress key",
);

const oldAssistant = {
  role: "assistant",
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: "old-call", name: "exec", arguments: {} }],
};
const failedAssistant = {
  role: "assistant",
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: "failed-call", name: "exec", arguments: {} }],
};
assert.equal(
  resolveSettledTerminalToolProgress({
    itemLifecycle: { activeCount: 0 },
    messagesSnapshot: [
      oldAssistant,
      { role: "toolResult", toolCallId: "old-call", isError: false },
      failedAssistant,
      { role: "toolResult", toolCallId: "failed-call", isError: true },
      { role: "assistant", stopReason: "stop", content: [] },
    ],
  }),
  null,
  "a failed latest tool batch must not fall back to older settled work",
);

assert.match(source, /MAX_SETTLED_TOOL_CONTINUATIONS_PER_PROGRESS = 2/);
assert.match(
  source,
  /settledToolProgress\.key !== settledToolContinuationProgressKey[\s\S]*?settledToolContinuationAttempts = 0/,
);
assert.match(source, /payloadCount === 0 && !emptyAssistantReplyIsSilent/);
assert.doesNotMatch(source, /restrictToolsForNextAttempt/);
assert.match(source, /complete every remaining step, using tools as needed/);
assert.match(source, /suppressNextUserMessagePersistence = true;/);
assert.match(
  source,
  /nextAttemptPromptOverride = SETTLED_TOOL_TERMINAL_CONTINUATION_PROMPT;/,
);

console.log("settled tool continuation regression: PASS");
