#!/bin/sh
set -eu

MODE=${1:-plan}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/functional-finn/REPLACE_WITH_TIMESTAMP}

run() {
  if [ "$MODE" = "--apply" ]; then
    "$@"
  else
    printf 'PLAN:'
    printf ' %s' "$@"
    printf '\n'
  fi
}

if [ "$MODE" = "--apply" ] && [ "$(id -u)" -ne 0 ]; then
  echo "rollback requires root" >&2
  exit 1
fi
if [ "$BACKUP_ROOT" = "/var/backups/functional-finn/REPLACE_WITH_TIMESTAMP" ]; then
  echo "set BACKUP_ROOT to the verified pre-install snapshot" >&2
  exit 1
fi

# Never return Signal credentials to _openclaw automatically. Rollback keeps all
# outbound sending disabled until an operator chooses and proves one exclusive owner.
run launchctl bootout system/com.functional-finn.release
run launchctl bootout system/com.functional-finn.signal
run mv /Library/LaunchDaemons/com.functional-finn.release.plist "$BACKUP_ROOT/disabled-release.plist"
run mv /Library/LaunchDaemons/com.functional-finn.signal.plist "$BACKUP_ROOT/disabled-signal.plist"
echo "Authority services disabled. Preserve ledgers, keys, and Signal store for audit."
echo "Do not restore the former OpenClaw Signal linked device without a new approval."
