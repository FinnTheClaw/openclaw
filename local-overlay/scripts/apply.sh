#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${1:-/opt/homebrew/lib/node_modules/openclaw}"
REQUIRE_PATCH_MATCH="${OPENCLAW_REQUIRE_PATCH_MATCH:-0}"

if [[ "${REQUIRE_PATCH_MATCH}" != "0" && "${REQUIRE_PATCH_MATCH}" != "1" ]]; then
  echo "ERROR: OPENCLAW_REQUIRE_PATCH_MATCH must be 0 or 1." >&2
  exit 1
fi

if [[ ! -d "${TARGET}" ]]; then
  echo "ERROR: OpenClaw target directory not found: ${TARGET}" >&2
  exit 1
fi

TARGET_VERSION="$(node -p 'require(process.argv[1]).version' "${TARGET}/package.json")"
SOURCE_BUILD_CONTRACT="$(
  node -p 'require(process.argv[1]).finnSourceBuild?.behaviorContract ?? ""' \
    "${TARGET}/package.json"
)"
if [[ "${SOURCE_BUILD_CONTRACT}" == "turn-lifecycle-v53" ]]; then
  echo "Source-integrated OpenClaw contract detected; compiled hot patches are historical only."
  "${SCRIPT_DIR}/verify.sh" "${TARGET}"
  echo "OpenClaw ${TARGET_VERSION} source-integrated verification complete."
  exit 0
fi
PATCH_DIR="${REPO_DIR}/patches/openclaw-${TARGET_VERSION}"
shopt -s nullglob
PATCH_FILES=("${PATCH_DIR}"/*.patch)
if [[ "${#PATCH_FILES[@]}" -eq 0 ]]; then
  if [[ "${REQUIRE_PATCH_MATCH}" == "1" ]]; then
    echo "ERROR: no version-matched local patch set for openclaw@${TARGET_VERSION}." >&2
    echo "Port and validate the patch set before packaging or publishing this OpenClaw version." >&2
    exit 1
  fi
  echo "No version-matched local patch set for openclaw@${TARGET_VERSION}; leaving package unpatched."
  exit 0
fi

# The 2026.7.1-2 turn-recovery patches are intentionally incremental and have
# overlapping compiled hunks. Apply them in the order in which they were
# validated live, then append any future version-matched patches.
if [[ "${TARGET_VERSION}" == "2026.7.1-2" ]]; then
  declare -a ORDERED_PATCH_FILES=()
  declare -A ORDERED_PATCH_NAMES=()
  for patch_name in \
    settled-tool-terminal-continuation.patch \
    turn-integrity-recovery.patch \
    transient-stream-continuation.patch \
    finalize-retry-failclosed.patch \
    tui-terminal-watchdog-reconcile.patch; do
    if [[ -f "${PATCH_DIR}/${patch_name}" ]]; then
      ORDERED_PATCH_FILES+=("${PATCH_DIR}/${patch_name}")
      ORDERED_PATCH_NAMES["${patch_name}"]=1
    fi
  done
  for patch_file in "${PATCH_FILES[@]}"; do
    patch_name="$(basename "${patch_file}")"
    [[ -n "${ORDERED_PATCH_NAMES[${patch_name}]:-}" ]] && continue
    ORDERED_PATCH_FILES+=("${patch_file}")
  done
  PATCH_FILES=("${ORDERED_PATCH_FILES[@]}")
fi

for patch_file in "${PATCH_FILES[@]}"; do
  while IFS= read -r file; do
    [[ -e "${TARGET}/${file}" ]] || continue
    if [[ ! -w "${TARGET}/${file}" ]]; then
      echo "ERROR: OpenClaw target is not writable: ${TARGET}/${file}" >&2
      echo "Re-run this installer with the minimum privilege required to modify the package." >&2
      exit 1
    fi
  done < <(sed -n 's#^+++ b/##p' "${patch_file}")
done

apply_patch_file() {
  local patch_file="$1"
  local label
  label="$(basename "${patch_file}")"

  if patch --dry-run --batch --forward -p1 -d "${TARGET}" < "${patch_file}" >/dev/null; then
    patch --batch --forward -p1 -d "${TARGET}" < "${patch_file}"
    if ! patch --dry-run --batch --forward -R -p1 -d "${TARGET}" < "${patch_file}" >/dev/null; then
      echo "ERROR: patch command returned success but post-apply verification failed: ${label}" >&2
      exit 1
    fi
    echo "applied: ${label}"
    return
  fi

  if patch --dry-run --batch --forward -R -p1 -d "${TARGET}" < "${patch_file}" >/dev/null; then
    echo "already applied: ${label}"
    return
  fi

  # A later cumulative patch can change the same compiled hunk, which makes
  # both forward and reverse patch probes fail even though the earlier
  # behavior is present and covered by its regression test.
  if [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
        "${label}" == "settled-tool-terminal-continuation.patch" ]] &&
     grep -Fq "SETTLED_TOOL_TERMINAL_CONTINUATION_PROMPT" \
       "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
     grep -Fq "FAILED_TOOL_CONTINUATION_PROMPT" \
       "${TARGET}/dist/embedded-agent-DGUuxGR2.js"; then
    echo "already applied (cumulative): ${label}"
    return
  fi
  if [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
        "${label}" == "turn-integrity-recovery.patch" ]] &&
     grep -Fq "FAILED_TOOL_CONTINUATION_PROMPT" \
       "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
     grep -Fq "UNEXPECTED_SILENT_REPLY_CONTINUATION_PROMPT" \
       "${TARGET}/dist/embedded-agent-DGUuxGR2.js" &&
     grep -Fq 'recordEvent("turn.terminal_decision"' \
       "${TARGET}/dist/selection-JInn13lc.js"; then
    echo "already applied (cumulative): ${label}"
    return
  fi
  if [[ "${TARGET_VERSION}" == "2026.7.1-2" &&
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
    echo "already applied (corrected cumulative): ${label}"
    return
  fi

  echo "ERROR: patch neither applies nor appears applied: ${label}" >&2
  exit 1
}

for patch_file in "${PATCH_FILES[@]}"; do
  apply_patch_file "${patch_file}"
done

"${SCRIPT_DIR}/verify.sh" "${TARGET}"

declare -A CHECKED_FILES=()
for patch_file in "${PATCH_FILES[@]}"; do
  while IFS= read -r file; do
    [[ "${file}" == *.js ]] || continue
    [[ -n "${CHECKED_FILES[${file}]:-}" ]] && continue
    node --check "${TARGET}/${file}"
    CHECKED_FILES["${file}"]=1
  done < <(sed -n 's#^+++ b/##p' "${patch_file}")
done
echo "OpenClaw ${TARGET_VERSION} patch apply complete. Restart gateway/node intentionally before relying on live behavior."
