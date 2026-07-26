# OpenClaw turn-integrity observability

This instrumentation distinguishes four failures that otherwise all look like
"Finn stopped":

1. the model returned a terminal stop or `NO_REPLY`;
2. a tool failed and OpenClaw accepted the failure as terminal progress;
3. the provider failed before a final answer;
4. OpenClaw produced a reply but channel delivery suppressed or rejected it.

## Always-on, bounded hooks

The provisioned `debug-hooks` plugin writes redacted JSONL records under
`~/.openclaw/workspace/debug/agent/`. Every file rotates at 8 MiB with four
retained generations.

- `turns.jsonl`: prompt/system-prompt hashes and sizes, message/tool counts,
  model resolution, and run/session correlation.
- `model-calls.jsonl`: provider/model/API, timing, outcome, context budget, and
  bounded upstream request-id hash.
- `model-io.jsonl`: input/output sizes and hashes, stop reason, usage, and a
  redacted bounded assistant-output preview. Raw user prompts are not logged.
- `tools.jsonl`: tool name/call ID, timing, result/error state, argument shape,
  command hash, and redacted bounded command/error previews.
- `finalize.jsonl`: the natural final answer, whether the bounded unfinished
  turn recovery requested another pass, and accumulated tool evidence.
- `agent-end.jsonl`: final success/error and duration.
- `delivery.jsonl`: inbound, normalized outbound, and delivered message
  correlation with content hashes and lengths.

The plugin is observational except for one clean-profile integrity rule:
promise-only terminal answers such as "Let me try another path:" receive at
most two continuation passes. Exact-count enforcement, operational-claim
guards, artifact blocking, and per-turn workspace backup remain disabled on
the clean profile.

## Core terminal-decision hook

Plugin hooks do not see OpenClaw's final trajectory classifier. The local
runtime patch therefore emits `turn.terminal_decision` into the existing
session trajectory with:

- terminal status and reason;
- assistant stop reason and visible text counts;
- tool count, active tool count, and whether the last tool failed;
- silent-policy decision;
- committed messaging, spawned-session, client-tool, and yield evidence.

It deliberately records no prompts, tool arguments, tool output, credentials,
or assistant text.

## Escalated captures

For a short isolated reproduction only, OpenClaw's supported raw-stream mode
can capture provider stream events:

```bash
OPENCLAW_RAW_STREAM=1 \
OPENCLAW_RAW_STREAM_PATH="$HOME/.openclaw/logs/raw-stream-canary.jsonl" \
openclaw agent --session-id turn-integrity-canary --message '...'
```

Raw streams can contain sensitive content and must not remain enabled in the
production gateway. Use them only for a bounded canary, restrict file mode to
`0600`, inspect locally, and delete or archive securely afterward.

OpenTelemetry or Prometheus diagnostic plugins are suitable for aggregate
rates and latency, but not as a substitute for the per-turn terminal-decision
event because they do not expose the classifier inputs that caused a silent
stop.
