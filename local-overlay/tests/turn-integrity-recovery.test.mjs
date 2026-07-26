import assert from "node:assert/strict";
import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node turn-integrity-recovery.test.mjs <openclaw-dir>");
}

const packageVersion = JSON.parse(fs.readFileSync(`${target}/package.json`, "utf8")).version;
const layouts = {
  "2026.7.1-2": {
    selection: "selection-JInn13lc.js",
    embedded: "embedded-agent-DGUuxGR2.js",
    getReply: "get-reply-OTG64ybi.js",
  },
  "2026.7.2": {
    selection: "selection-C50GdcQc.js",
    embedded: "embedded-agent-BWIVdi3c.js",
    getReply: "get-reply-DE2xroan.js",
  },
};
const layout = layouts[packageVersion];
assert.ok(layout, `turn-integrity regression has no compiled layout for OpenClaw ${packageVersion}`);

const selection = fs.readFileSync(`${target}/dist/${layout.selection}`, "utf8");
const embedded = fs.readFileSync(`${target}/dist/${layout.embedded}`, "utf8");
const getReply = fs.readFileSync(`${target}/dist/${layout.getReply}`, "utf8");

const terminalMatch = selection.match(
  /function resolveAttemptTrajectoryTerminal\(params\) \{[\s\S]*?\n\}/,
);
assert.ok(terminalMatch, "compiled terminal classifier must exist");
const resolveAttemptTrajectoryTerminal = Function(
  `"use strict";
  const NON_DELIVERABLE_TERMINAL_TURN_REASON = "non_deliverable_terminal_turn";
  const hasNonEmptyAssistantText = (texts) => texts.some((text) => text.trim().length > 0);
  const hasCommittedMessagingDeliveryEvidence = (params) =>
    params.messagingToolSentTexts.length > 0 ||
    params.messagingToolSentMediaUrls.length > 0 ||
    params.messagingToolSentTargets.length > 0;
  const hasAcceptedSessionSpawn = (spawns) => spawns.length > 0;
  const hasAsyncStartedToolActivity = (metas) => metas.some((meta) => meta.asyncStarted === true);
  const hasAsyncStartedToolActivity$1 = hasAsyncStartedToolActivity;
  ${terminalMatch[0]}
  return resolveAttemptTrajectoryTerminal;`,
)();

const baseTerminal = {
  promptError: undefined,
  aborted: false,
  externalAbort: false,
  timedOut: false,
  assistantTexts: [],
  toolMetas: [],
  didSendDeterministicApprovalPrompt: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  successfulCronAdds: 0,
  synthesizedPayloadCount: 0,
  acceptedSessionSpawns: [],
  heartbeatToolResponse: undefined,
  clientToolCalls: [],
  yieldDetected: false,
  lastToolError: undefined,
  silentExpected: false,
  emptyAssistantReplyIsSilent: false,
  lastAssistantStopReason: "stop",
  hasTerminalOutput: false,
};

assert.deepEqual(
  resolveAttemptTrajectoryTerminal({
    ...baseTerminal,
    lastToolError: new Error("expected canary failure"),
  }),
  { status: "error", terminalError: "non_deliverable_terminal_turn" },
  "a failed tool alone must not count as delivered terminal output",
);
assert.deepEqual(
  resolveAttemptTrajectoryTerminal({
    ...baseTerminal,
    messagingToolSentTexts: ["delivered"],
    lastAssistantStopReason: "error",
  }),
  { status: "success" },
  "committed messaging delivery remains valid after a later provider error",
);
assert.deepEqual(
  resolveAttemptTrajectoryTerminal({
    ...baseTerminal,
    assistantTexts: ["Working on it.", "I found the likely cause."],
    synthesizedPayloadCount: 2,
    lastAssistantStopReason: "error",
  }),
  { status: "error", terminalError: "non_deliverable_terminal_turn" },
  "partial progress must not make a provider stream error look successful",
);

assert.doesNotMatch(
  selection.match(/function hasAttemptTerminalState\(attempt\) \{[\s\S]*?\n\}/)?.[0] ?? "",
  /attempt\.lastToolError/,
  "lastToolError must not be treated as terminal progress",
);
assert.doesNotMatch(
  selection.match(/function resolveIncompleteTurnPayloadText\(params\) \{[\s\S]*?\n\}/)?.[0] ?? "",
  /didSendDeterministicApprovalPrompt \|\| params\.attempt\.lastToolError/,
  "lastToolError must not suppress the visible incomplete-turn path",
);
assert.match(selection, /recordEvent\("turn\.terminal_decision"/);
assert.match(selection, /lastToolError: (?:lastToolError|result\.lastToolError) !== void 0/);
assert.match(
  selection,
  /before_agent_finalize requested (?:bounded )?continuation after (?:potential )?side effects/,
);
assert.doesNotMatch(
  selection,
  /before_agent_finalize requested revision after potential side effects; finalizing/,
);

if (packageVersion === "2026.7.1-2") {
  assert.match(embedded, /FAILED_TOOL_CONTINUATION_PROMPT/);
  assert.match(embedded, /failedToolContinuationAttempts < 2/);
  assert.match(embedded, /failed tool turn lacked recovery\/final answer/);
  assert.match(embedded, /TRANSIENT_TRANSPORT_CONTINUATION_PROMPT/);
  assert.match(embedded, /MAX_TRANSIENT_TRANSPORT_CONTINUATIONS = 2/);
  assert.match(
    embedded,
    /nextAttemptPromptOverride = TRANSIENT_TRANSPORT_CONTINUATION_PROMPT/,
  );
  assert.match(embedded, /suppressNextUserMessagePersistence = true/);
  assert.match(embedded, /\[transient-transport-continuation\]/);
} else {
  assert.match(embedded, /MAX_RECOVERABLE_TOOL_ERROR_CONTINUATIONS = 2/);
  assert.match(
    embedded,
    /recoverableToolErrorContinuationAttempts < MAX_RECOVERABLE_TOOL_ERROR_CONTINUATIONS/,
  );
  assert.doesNotMatch(embedded, /recoverableToolErrorContinuationAttempts < 8/);
}
assert.match(embedded, /UNEXPECTED_SILENT_REPLY_CONTINUATION_PROMPT/);
assert.match(
  embedded,
  /unexpectedSilentReplyContinuationAttempts < (?:1|MAX_UNEXPECTED_SILENT_REPLY_CONTINUATIONS)/,
);
assert.match(embedded, /Agent repeatedly attempted a silent reply to a direct user request/);
assert.match(embedded, /SETTLED_TOOL_TERMINAL_CONTINUATION_PROMPT/);
assert.match(embedded, /hasSettledTerminalToolUse/);
assert.match(embedded, /restrictToolsForNextAttempt/);

assert.match(
  getReply,
  /silentReplySettings\.policy === "disallow" \|\| directChatContext/,
  "direct sessions must not receive generic NO_REPLY guidance",
);

console.log("turn integrity recovery regression: PASS");
