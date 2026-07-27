#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${1:-/opt/homebrew/lib/node_modules/openclaw}"

if [[ ! -d "${TARGET}" ]]; then
  echo "ERROR: OpenClaw target directory not found: ${TARGET}" >&2
  exit 1
fi

TARGET_VERSION="$(node -p 'require(process.argv[1]).version' "${TARGET}/package.json")"
PATCH_DIR="${REPO_DIR}/patches/openclaw-${TARGET_VERSION}"
shopt -s nullglob
PATCH_FILES=("${PATCH_DIR}"/*.patch)

echo "target=${TARGET}"
if [[ -f "${TARGET}/package.json" ]]; then
  node -e 'const p=require(process.argv[1]); console.log(`package=${p.name}@${p.version}`)' "${TARGET}/package.json"
fi

if [[ "${#PATCH_FILES[@]}" -eq 0 ]]; then
  echo "No version-matched local patch set for openclaw@${TARGET_VERSION}; skipping patch verification."
  exit 0
fi

failed=0
for patch_file in "${PATCH_FILES[@]}"; do
  label="$(basename "${patch_file}")"
  if patch --dry-run --batch --forward -R -p1 -d "${TARGET}" < "${patch_file}" >/dev/null; then
    echo "applied: ${label}"
  elif patch --dry-run --batch --forward -p1 -d "${TARGET}" < "${patch_file}" >/dev/null; then
    echo "missing: ${label}"
    failed=1
  elif [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
          "${label}" == "settled-tool-terminal-continuation.patch" ]] &&
       grep -Fq "SETTLED_TOOL_TERMINAL_CONTINUATION_PROMPT" \
         "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
       grep -Fq "FAILED_TOOL_CONTINUATION_PROMPT" \
         "${TARGET}/dist/embedded-agent-DGUuxGR2.js"; then
    echo "applied (cumulative): ${label}"
  elif [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
          "${label}" == "turn-integrity-recovery.patch" ]] &&
       grep -Fq "FAILED_TOOL_CONTINUATION_PROMPT" \
         "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
       grep -Fq "UNEXPECTED_SILENT_REPLY_CONTINUATION_PROMPT" \
         "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
       grep -Fq 'recordEvent("turn.terminal_decision"' \
         "${TARGET}/dist/selection-JInn13lc.js"; then
    echo "applied (cumulative): ${label}"
  elif [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
          "${label}" == "finalize-retry-failclosed.patch" ]] &&
       grep -Fq "session.status = status" \
         "${TARGET}/dist/bash-process-registry-17q1dHVV.js" &&
       grep -Fq "moveToFinished(session, session.status ?? \"failed\")" \
         "${TARGET}/dist/bash-process-registry-17q1dHVV.js" &&
       ! grep -Fq "activeBackgroundExecSessionIds" \
         "${TARGET}/dist/bash-process-registry-17q1dHVV.js" &&
       grep -Fq 'action: "exhausted"' \
         "${TARGET}/dist/lifecycle-hook-helpers-BwL6869q.js" &&
       grep -Fq 'outcome.action !== "revise" && outcome.action !== "exhausted"' \
         "${TARGET}/dist/selection-JInn13lc.js"; then
    echo "applied (corrected cumulative): ${label}"
  else
    echo "conflict: ${label}"
    failed=1
  fi
done

if [[ "${TARGET_VERSION}" == "2026.6.6" ]]; then
required_symbols=(
  "dist/monitor-DLQu0UP3.js:SIGNAL_INBOUND_QUEUE_VERSION"
  "dist/monitor-DLQu0UP3.js:createSignalDurableInboundQueue"
  "dist/monitor-DLQu0UP3.js:editTargetTimestamp"
  "dist/send-hICEM6a-.js:resolveSignalQuoteFromInboundQueue"
  "dist/send-hICEM6a-.js:OPENCLAW_SIGNAL_ALLOW_UNRESOLVED_REPLY"
  "dist/message-D5B8ddQe.js:params.replyToId ?? params.replyTo"
  "dist/message-action-runner-6wCJfhlZ.js:normalizedArgs.reply_to"
  "dist/message-action-runner-6wCJfhlZ.js:enforceSignalSourceReplyTo"
  "dist/message-action-runner-6wCJfhlZ.js:Signal source replies through the message tool require replyTo/replyToId"
  "dist/channel-BEL8ozXJ.js:nativeQuote: true"
  "dist/channel-BEL8ozXJ.js:deps, replyToId, abortSignal"
  "dist/channel-BEL8ozXJ.js:replyToId: ctx.replyToId"
  "dist/launchd-FSKBDZ2p.js:isCurrentGatewayLaunchdLabel(label, serviceEnv) ? await resolveLaunchAgentGatewayPort(serviceEnv) : null"
  "dist/selection-BP0T9R9I.js:isEmptyTerminalAssistantMessage"
  "dist/selection-BP0T9R9I.js:isTranscriptOnlyOpenClawAssistantMessage(msg) || isEmptyTerminalAssistantMessage(msg)"
  "dist/compaction-successor-transcript-ONv2lneO.js:isEmptyTerminalAssistantMessage"
  "dist/compaction-successor-transcript-ONv2lneO.js:sessionFile && !isEmptyTerminalAssistantMessage"
  "dist/descriptors-odCTYLLK.js:const FILE_WRITE_HARD_MAX_BYTES = Number.MAX_SAFE_INTEGER"
  "dist/descriptors-odCTYLLK.js:No OpenClaw decoded-byte cap is applied"
  "dist/session-fork-BC-jKOPF.js:resolveParentForkMaxTokens"
  "dist/session-fork-BC-jKOPF.js:params.parentEntry?.contextTokens"
  "dist/session-fork-BC-jKOPF.js:params.cfg?.agents?.defaults?.contextTokens"
  "dist/session-fork-BC-jKOPF.js:resolveContextTokensForModel"
  "dist/openclaw-tools-C0nKaVVY.js:cfg: params.cfg"
  "dist/get-reply-DW1jVSLI.js:cfg,"
  "dist/realtime-voice-BRCFRGg7.js:cfg: params.cfg"
  "dist/skill-workshop-prompt-Ro8fA5Wx.js:treat that as authorization to create or revise the proposal"
  "dist/skill-workshop-prompt-Ro8fA5Wx.js:proposal-only review"
  "dist/thinking-policy-D2pce6l8.js:\"gpt-5.6\""
  "dist/thinking-policy-D2pce6l8.js:startsWith(\"gpt-5.6\")"
  "dist/thinking-policy-D2pce6l8.js:{ id: \"max\" }"
)
for item in "${required_symbols[@]}"; do
  file="${item%%:*}"
  symbol="${item#*:}"
  if ! grep -Fq "${symbol}" "${TARGET}/${file}"; then
    echo "missing symbol: ${file}: ${symbol}" >&2
    failed=1
  fi
done

for file in \
  dist/dispatch-DO0Fpkbp.js \
  dist/launchd-FSKBDZ2p.js \
  dist/lifecycle-core-BDdRclCf.js \
  dist/message-D5B8ddQe.js \
  dist/message-action-runner-6wCJfhlZ.js \
  dist/monitor-DLQu0UP3.js \
  dist/notification-correlation-x98jecIj.js \
  dist/openai-completions-DObeyZ3K.js \
  dist/get-reply-DW1jVSLI.js \
  dist/openclaw-tools-C0nKaVVY.js \
  dist/realtime-voice-BRCFRGg7.js \
  dist/session-fork-BC-jKOPF.js \
  dist/selection-BP0T9R9I.js \
  dist/skill-workshop-prompt-Ro8fA5Wx.js \
  dist/compaction-successor-transcript-ONv2lneO.js \
  dist/descriptors-odCTYLLK.js \
  dist/status-text-B8Mjm64n.js; do
  node --check "${TARGET}/${file}"
done
node --check "${TARGET}/dist/thinking-policy-D2pce6l8.js"

fi

declare -A CHECKED_FILES=()
for patch_file in "${PATCH_FILES[@]}"; do
  while IFS= read -r file; do
    [[ "${file}" == *.js ]] || continue
    [[ -n "${CHECKED_FILES[${file}]:-}" ]] && continue
    node --check "${TARGET}/${file}"
    CHECKED_FILES["${file}"]=1
  done < <(sed -n 's#^+++ b/##p' "${patch_file}")
done

if [[ "${TARGET_VERSION}" == "2026.7.1-2" ]]; then
  node "${REPO_DIR}/tests/finalize-retry-failclosed.test.mjs" "${TARGET}"
  node "${REPO_DIR}/tests/local-model-orchestration-v29.test.mjs" "${TARGET}"
  node "${REPO_DIR}/tests/recovered-cli-usage-errors.test.mjs" "${TARGET}"
  node "${REPO_DIR}/tests/settled-tool-terminal-continuation.test.mjs" "${TARGET}"
  node "${REPO_DIR}/tests/tui-terminal-watchdog-reconcile.test.mjs" "${TARGET}"
  node "${REPO_DIR}/tests/turn-integrity-recovery.test.mjs" "${TARGET}"
fi
if [[ "${TARGET_VERSION}" == "2026.7.2" ]]; then
  node "${REPO_DIR}/tests/turn-integrity-recovery.test.mjs" "${TARGET}"
fi

if [[ "${failed}" -ne 0 ]]; then
  echo "OpenClaw patch verification failed." >&2
  exit 1
fi

echo "OpenClaw patch verification passed."
