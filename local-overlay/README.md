# OpenClaw Patches

Durable local patch registry for Finn's OpenClaw installation on Moira.

The live OpenClaw CLI is installed as a global npm package at:

```text
/opt/homebrew/lib/node_modules/openclaw
```

Direct edits under that package tree are upgrade-fragile. A manual `openclaw update`, `npm install -g openclaw@...`, or package reinstall can overwrite them. This repository keeps every local OpenClaw hot patch as a reproducible artifact with apply and verify commands.

## Current Patches

| Patch | Base OpenClaw | Target | Purpose |
| --- | --- | --- | --- |
| `patches/openclaw-2026.6.6/signal-durable-inbound-queue.patch` | `2026.6.6` | `dist/monitor-DLQu0UP3.js` | Persist Signal inbound events to a durable ledger before dispatch, then replay unprocessed events after gateway restart. |
| `patches/openclaw-2026.6.6/additional-local-hotpatches-20260629.patch` | `2026.6.6` | multiple `dist/*.js` files | Capture the remaining installed-package hot patches present on Moira as of 2026-06-29. |
| `patches/openclaw-2026.6.6/signal-native-quote-replies.patch` | `2026.6.6` | `dist/send-hICEM6a-.js`, `dist/send-De5Th-L4.d.ts`, `dist/message-D5B8ddQe.js`, `dist/message-action-runner-6wCJfhlZ.js`, `dist/channel-BEL8ozXJ.js` | Map explicit `replyTo`/`replyToId` into native Signal quote fields and fail closed if the durable queue cannot resolve the requested quote. |
| `patches/openclaw-2026.6.6/suppress-empty-terminal-assistant-events.patch` | `2026.6.6` | `dist/selection-BP0T9R9I.js`, `dist/compaction-successor-transcript-ONv2lneO.js` | Keep retryable empty terminal assistant turns out of live TUI transcript broadcasts while preserving them for retry classification. |
| `patches/openclaw-2026.6.6/file-write-unbounded-decoded-bytes.patch` | `2026.6.6` | `dist/descriptors-odCTYLLK.js` | Remove OpenClaw's decoded-byte hard cap from `file_write` so paired-node disk writes can exceed 16 MiB when transport and memory allow. |
| `patches/openclaw-2026.6.6/skill-workshop-live-by-default.patch` | `2026.6.6` | `dist/skill-workshop-prompt-Ro8fA5Wx.js` | Make Skill Workshop create/add/integrate/install/update requests validate and apply live skills unless the user asks for proposal-only review. |
| `patches/openclaw-2026.6.6/node-restart-skip-gateway-port-preflight.patch` | `2026.6.6` | `dist/launchd-FSKBDZ2p.js` | Let node LaunchAgent restarts proceed while the gateway owns port `18789`; only gateway LaunchAgents run gateway listener stale-process cleanup. |
| `patches/openclaw-2026.6.6/openai-gpt56-thinking-policy.patch` | `2026.6.6` | `dist/thinking-policy-D2pce6l8.js` | Backport upstream beta GPT-5.6 OpenAI thinking-policy support for `xhigh` and `max` without upgrading the full package. |
| `patches/openclaw-2026.7.1-2/settled-tool-terminal-continuation.patch` | `2026.7.1-2` | `dist/embedded-agent-DGUuxGR2.js` | Continue once from verified completed tool results when a model ends on `toolUse`, exposing only the replay-safe `read` tool so completed mutations cannot replay. |
| `patches/openclaw-2026.7.1-2/turn-integrity-recovery.patch` | `2026.7.1-2` | `dist/embedded-agent-DGUuxGR2.js`, `dist/selection-JInn13lc.js`, `dist/get-reply-OTG64ybi.js` | Recover boundedly after silent failed-tool turns or accidental direct-chat `NO_REPLY`, reject tool errors as terminal delivery, permit a bounded unfinished-turn revision from the current transcript, and record the terminal classifier inputs in trajectory logs. |
| `patches/openclaw-2026.7.1-2/transient-stream-continuation.patch` | `2026.7.1-2` | `dist/embedded-agent-DGUuxGR2.js`, `dist/selection-JInn13lc.js` | Fail closed when a provider stream ends with `stopReason=error` after partial progress, then continue the persisted turn up to twice for transient transport failures without replaying the original request. |
| `patches/openclaw-2026.7.1-2/finalize-retry-failclosed.patch` | `2026.7.1-2` | four runner/process `dist/*.js` files | Reject unfinished progress text after the finalization retry budget is exhausted, surface a visible `incomplete_turn` error, and retain fast-exiting background process results for polling. |
| `patches/openclaw-2026.7.1-2/finn-wedge-rootcause.patch` | `2026.7.1-2` | exec registry, embedded runner, and restart recovery | Prevent fast exec from crashing the gateway, reject a final `NO_REPLY` even after progress text, and send recovery notices through Signal's supported generic send route. |
| `patches/openclaw-2026.7.1-2/recovered-cli-usage-errors.patch` | `2026.7.1-2` | `dist/tool-mutation-BfXv6cQw.js`, `dist/selection-JInn13lc.js` | Suppress an obsolete exec warning after the same OpenClaw agent request succeeds with a corrected target selector, while retaining unrelated failures. |
| `patches/debug-hooks/turn-integrity-v27.patch` | Finn debug-hooks plugin | `~/.openclaw/plugins/debug-hooks/index.js` | Keep classifying unfinished output as a revision request while core owns the bounded retry budget and visible terminal failure. |
| `patches/debug-hooks/turn-integrity-v28.patch` | Finn and Jake debug-hooks plugin | live plugin, managed canonical hook, and provisioner source | Preserve v27 fail-closed behavior while accepting tool-proven external permission blockers and user-facing “let me know” language as legitimate terminal answers. |
| `patches/openclaw-2026.7.1-2/tui-terminal-watchdog-reconcile.patch` | `2026.7.1-2` | `dist/tui-ttOZNpsl.js` | Reconcile a silent TUI run against canonical session history before declaring it stuck; clear stale spinners only when the session is terminal and has no in-flight run. |
| `patches/openclaw-2026.7.2/jake-parent-fork-dynamic-context-tokens.patch` | `2026.7.2` | `dist/session-accessor-BFted17j.js`, `dist/session-fork-B2y_KaMK.js` | Use the actual Jake parent/model context budget for child-session inheritance instead of a fixed 100k-token ceiling. |
| `patches/openclaw-2026.7.2/turn-integrity-recovery.patch` | `2026.7.2` | `dist/embedded-agent-BWIVdi3c.js`, `dist/selection-C50GdcQc.js`, `dist/get-reply-DE2xroan.js` | Give Jakes the same bounded failed-tool, completed-tool, accidental-silence, classifier, and trajectory fixes as Finn without retaining the upstream eight-pass tool-error loop. |

## Reapply After Upgrade

From this repo:

```bash
./scripts/apply.sh /opt/homebrew/lib/node_modules/openclaw
./scripts/verify.sh /opt/homebrew/lib/node_modules/openclaw
```

Restart commands are available directly from the terminal or agent operations. Use the native path:

```bash
openclaw gateway restart
sleep 8
openclaw gateway status --deep
```

If node config changes were also made, restart the node service as well after the gateway port is clear.

## Settled-Tool Recovery Rollback

For the `openclaw@2026.7.1-2` continuation patch, the full pre-change snapshot is:

```text
/Users/aiapi/backups/finn-incomplete-tool-turn-20260725T032254Z
```

The patch can also be reversed directly:

```bash
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/settled-tool-terminal-continuation.patch
sudo launchctl kickstart -k system/com.finnclaw.openclaw.finn
```

## TUI Terminal-Reconciliation Rollback

The pre-change snapshot is:

```text
/Users/aiapi/backups/finn-tui-terminal-reconcile-20260725T043825Z
```

Reversing this patch affects newly started TUI processes only; no gateway restart is required:

```bash
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/tui-terminal-watchdog-reconcile.patch
```

## Transient Stream Continuation Rollback

The live pre-change snapshot path is:

```text
/Users/aiapi/backups/finn-transient-stream-continuation-20260725T*
```

Reverse only the transient-stream recovery patch with:

```bash
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/transient-stream-continuation.patch
sudo launchctl kickstart -k system/com.finnclaw.openclaw.finn
```

The continuation is bounded to two retries, uses the persisted transcript
instead of replaying the original user prompt, and is ineligible for real
run-budget timeouts, explicit aborts, authentication/rate-limit/billing
failures, or turns that already committed a user-visible delivery.

## Turn-Integrity Recovery Rollback

The live install snapshot path is recorded when the candidate is promoted. To
reverse only this patch:

```bash
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/turn-integrity-recovery.patch
sudo launchctl kickstart -k system/com.finnclaw.openclaw.finn
```

The patch adds bounded recovery only: up to two changed-approach continuations
after a failed tool, one retry for an accidental silent direct reply, and the
existing configured `before_agent_finalize` revision budget for a promise-only
answer. A successful tool-only terminal turn gets one read-only finalization
pass. It does not replay the original prompt.

Terminal classification is emitted as `turn.terminal_decision` in each
session trajectory. The provisioned `debug-hooks` plugin correlates model,
tool, finalization, and delivery events under
`~/.openclaw/workspace/debug/agent/` with redaction and 8 MiB rotation.
See `docs/turn-integrity-observability.md` for event coverage and the bounded
raw-stream escalation procedure.

The equivalent Jake patch is version-specific to `openclaw@2026.7.2`. Reverse
it from a matching package with:

```bash
sudo patch --batch -R -p1 -d /path/to/openclaw \
  < patches/openclaw-2026.7.2/turn-integrity-recovery.patch
```

## Finalize-Retry Fail-Closed Rollback

The complete pre-change snapshot, including compiled files, debug-hooks plugin,
configuration, hashes, and rollback script, is:

```text
/Users/aiapi/backups/finn-followthrough-failclosed-20260726T042804Z
```

The installed-package repair is incremental from the prior turn-integrity and
transient-stream patches. Reverse it without touching those earlier repairs:

```bash
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/finalize-retry-failclosed.patch
patch --batch -R -p1 -d ~/.openclaw/plugins/debug-hooks \
  < patches/debug-hooks/turn-integrity-v27.patch
```

Restore `plugins.entries.debug-hooks.config.maxRevisionAttempts` to its
pre-change value, validate the configuration, and intentionally recycle the
gateway. The snapshot rollback script restores all affected files and config
as one unit.

## Finn Wedge Root-Cause Rollback

The complete pre-change snapshot is:

```text
/Users/aiapi/backups/finn-wedge-rootcause-20260726T164526Z
```

Reverse the corrective core and hook patches in this order, validate, then
intentionally recycle the gateway once:

```bash
patch --batch -R -p1 -d ~/.openclaw/plugins/debug-hooks \
  < patches/debug-hooks/turn-integrity-v28.patch
sudo patch --batch -R -p1 -d /opt/homebrew/lib/node_modules/openclaw \
  < patches/openclaw-2026.7.1-2/finn-wedge-rootcause.patch
```

## Jake Parent-Fork Context Rollback

The `openclaw@2026.7.2` Jake patch is version-specific and is not applied to
Moira's current `openclaw@2026.7.1-2` installation. On a matching Jake target,
reverse it with:

```bash
sudo patch --batch -R -p1 -d /path/to/openclaw \
  < patches/openclaw-2026.7.2/jake-parent-fork-dynamic-context-tokens.patch
```

## Patch Hygiene

- Never rely on a direct package-tree hot patch unless it is recorded here.
- Record the base OpenClaw version, target file, reason, verification, and rollback note.
- Keep patches small and single-purpose.
- After a whole-package upgrade, run `verify.sh`; if a patch no longer applies, port it intentionally instead of editing the installed tree silently.
- Keep this repo private unless all patches and docs have been reviewed for local infrastructure details.

## Runtime State

The Signal queue patch writes durable inbound records under:

```text
~/.openclaw/channel-inbound-queue/signal/<account>/events.jsonl
```

That ledger is append-only by design. Records are marked with `enqueued` and `processed` actions so gateway restarts can replay pending inbound messages without depending on in-memory task queues.
