#!/bin/sh
set -eu

MODE=${1:-plan}
RELEASE_ID=${RELEASE_ID:-REPLACE_WITH_HASHED_RELEASE_ID}

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
  echo "install requires root" >&2
  exit 1
fi
if [ "$RELEASE_ID" = "REPLACE_WITH_HASHED_RELEASE_ID" ]; then
  echo "set RELEASE_ID to a hash-bound immutable release" >&2
  exit 1
fi

assert_identity_id() {
  container=$1
  name=$2
  attribute=$3
  expected=$4
  if existing=$(dscl . -read "/$container/$name" "$attribute" 2>/dev/null); then
    actual=$(printf '%s\n' "$existing" | awk -F ': ' -v key="$attribute" '$1 == key {print $2}')
    if [ "$actual" != "$expected" ]; then
      echo "$container/$name has $attribute=$actual, expected $expected" >&2
      exit 1
    fi
  fi
  conflicts=$(dscl . -search "/$container" "$attribute" "$expected" 2>/dev/null | awk '{print $1}' | grep -v "^$name$" || true)
  if [ -n "$conflicts" ]; then
    echo "$attribute $expected is already owned by $conflicts" >&2
    exit 1
  fi
}

# Collision checks finish before plan/apply emits its first prospective mutation.
assert_identity_id Groups _finnrel PrimaryGroupID "${FINNREL_GID:-470}"
assert_identity_id Groups _finnsig PrimaryGroupID "${FINNSIG_GID:-471}"
assert_identity_id Groups _finnsubmit PrimaryGroupID "${FINNSUBMIT_GID:-570}"
assert_identity_id Groups _finnrelease PrimaryGroupID "${FINNRELEASE_GID:-571}"
assert_identity_id Groups _finningress PrimaryGroupID "${FINNINGRESS_GID:-572}"
assert_identity_id Users _finnrel UniqueID "${FINNREL_UID:-470}"
assert_identity_id Users _finnsig UniqueID "${FINNSIG_UID:-471}"

# Fixed IDs are selected and collision-checked by the operator before apply.
for record in "_finnrel:${FINNREL_GID:-470}" "_finnsig:${FINNSIG_GID:-471}" "_finnsubmit:${FINNSUBMIT_GID:-570}" "_finnrelease:${FINNRELEASE_GID:-571}" "_finningress:${FINNINGRESS_GID:-572}"; do
  group=${record%%:*}
  gid=${record#*:}
  if ! dscl . -read "/Groups/$group" >/dev/null 2>&1; then
    run dscl . -create "/Groups/$group"
    run dscl . -create "/Groups/$group" PrimaryGroupID "$gid"
  fi
done

for record in "_finnrel:${FINNREL_UID:-470}:${FINNREL_GID:-470}:release authority" "_finnsig:${FINNSIG_UID:-471}:${FINNSIG_GID:-471}:Signal sender"; do
  user=${record%%:*}
  rest=${record#*:}
  uid=${rest%%:*}
  rest=${rest#*:}
  gid=${rest%%:*}
  label=${rest#*:}
  if ! dscl . -read "/Users/$user" >/dev/null 2>&1; then
    run dscl . -create "/Users/$user"
    run dscl . -create "/Users/$user" UniqueID "$uid"
    run dscl . -create "/Users/$user" PrimaryGroupID "$gid"
    run dscl . -create "/Users/$user" UserShell /usr/bin/false
    run dscl . -create "/Users/$user" NFSHomeDirectory /var/empty
    run dscl . -create "/Users/$user" RealName "$label"
  fi
done

run dseditgroup -o edit -a _openclaw -t user _finnsubmit
run dseditgroup -o edit -a _finnrel -t user _finnsubmit
run dseditgroup -o edit -a _finnrel -t user _finnrelease
run dseditgroup -o edit -a _finnsig -t user _finnrelease
run dseditgroup -o edit -a _openclaw -t user _finningress
run dseditgroup -o edit -a _finnsig -t user _finningress

run install -d -o root -g wheel -m 0755 /Library/FunctionalFinn
run install -d -o root -g wheel -m 0755 "/Library/FunctionalFinn/releases/$RELEASE_ID"
run install -d -o root -g wheel -m 0755 /Library/FunctionalFinn/policy
run install -d -o _finnrel -g _finnrel -m 0700 /var/db/functional-finn/release
run install -d -o _finnsig -g _finnsig -m 0700 /var/db/functional-finn/signal
run install -d -o root -g wheel -m 0755 /var/run/functional-finn
run install -d -o root -g _finnsubmit -m 0750 /var/run/functional-finn/release-candidate
run install -d -o root -g _finnrelease -m 0750 /var/run/functional-finn/signal-release
run install -d -o root -g _finningress -m 0750 /var/run/functional-finn/signal-ingress
run install -d -o root -g wheel -m 0755 /var/log/functional-finn
run install -o _finnrel -g _finnrel -m 0600 /dev/null /var/log/functional-finn/release.log
run install -o _finnrel -g _finnrel -m 0600 /dev/null /var/log/functional-finn/release.err.log
run install -o _finnsig -g _finnsig -m 0600 /dev/null /var/log/functional-finn/signal.log
run install -o _finnsig -g _finnsig -m 0600 /dev/null /var/log/functional-finn/signal.err.log

echo "Templates are not copied or bootstrapped by this foundation script."
echo "Before enforcement: verify hashes, install root-owned policy/binaries/plists,"
echo "migrate Signal credentials to _finnsig, revoke the old linked device, run"
echo "negative _openclaw access proofs, then bootstrap each service exactly once."
