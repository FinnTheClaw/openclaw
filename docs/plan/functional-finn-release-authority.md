# Functional Finn two-daemon release authority

Status: source-complete transport/runtime candidate under correction; not installed, loaded, or
connected to Signal. Dedicated-UID and linked-device isolation remain unproven.

Exact review history:

- `4040cf65cffaba8e590198349fa94a4be14994e2`: **NO-GO**, 1 P0 / 3 P1.
- `f241d5a61b07c74a71d772003901886bca113397`: **NO-GO**, 2 P0 / 8 P1.

The current uncommitted source includes the TypeScript `candidate.submit`/`ingress.pull` protected
adapter and an adapter-level hard fence that remains fail-closed when the coordination hooks time out or
throw. These are source-complete, not independently reviewed GO and not live.

## Security boundary

The release boundary is two OS identities, not a plugin assertion:

1. `_openclaw` submits an untrusted candidate to `_finnrel` and may pull
   normalized ingress from `_finnsig`.
2. `_finnrel` independently validates the candidate envelope, exact evidence
   spans, scope, freshness, quarantine/supersession state, and provenance. It
   owns the candidate ledger and Ed25519 private key. It may request exactly one
   revision. A valid final candidate becomes one immutable signed text frame.
3. `_finnsig` verifies the frame against its root-installed `_finnrel` public
   key, derives the destination only from its own normalized ingress binding,
   records the frame, and makes at most one automatic physical send attempt.
4. `_finnsig` alone owns the Signal linked-device store and transport socket.
   `_openclaw` has no filesystem, group, key, credential, or peer-UID authority
   to the physical-send endpoint.

Root owns versioned binaries, launchd plists, policy, socket parents, and the
public-key pin. Each daemon checks the kernel-reported Unix peer UID before it
reads the four-byte request header. Mode bits are defense in depth, not caller
authentication.

This authority does not provide general planner, TaskFlow, tool-loop, task, subagent, or completion
authority. It does not schedule tools, control turns, or spawn children. It gates only response release
and verified-memory admission.

## Reviewed finding consolidation

The exact `f241d5a6` review reported 2 P0 / 8 P1:

| Severity | Exact finding                                             | Root owner                         | Items   |
| -------- | --------------------------------------------------------- | ---------------------------------- | ------- |
| P0       | Public notice flags could mint a bypass.                  | Signal/revision delivery           | 7, 8    |
| P0       | The same-UID verifier socket was a signing oracle.        | Two-daemon external authority      | 8       |
| P1       | Revision state was evictable.                             | Signal/revision delivery           | 7, 8    |
| P1       | Delivery rows were evictable.                             | Signal/revision delivery           | 8       |
| P1       | Unknown RPC outcomes could be marked sent.                | Signal/revision delivery           | 8       |
| P1       | Protected replies could be chunked.                       | Signal/revision delivery           | 7, 8    |
| P1       | TypeScript/Python canonical bytes could diverge.          | Two-daemon external authority      | 7, 8    |
| P1       | Projection paths/migration were unsafe.                   | Builtin-memory projection/evidence | 6, 9    |
| P1       | Projection startup/close was not bounded or fail-visible. | Builtin-memory projection/evidence | 6, 9    |
| P1       | Evidence was serialized before byte-bound enforcement.    | Builtin-memory projection/evidence | 6, 7, 9 |

These findings close through three roots only: Signal/revision delivery, builtin-memory
projection/evidence, and the two-daemon external authority. They do not justify any expansion into task
or execution governance.

## Protocol and canonical bytes

The frozen repository has no CBOR dependency. Adding one solely for IPC would
increase the supply-chain surface, so the MVP uses a closed canonical UTF-8 JSON
codec:

- four-byte unsigned big-endian body length;
- maximum checked before body read, UTF-8 decode, or JSON parsing;
- no floats, non-finite numbers, duplicate keys, surrogates, or noncanonical
  whitespace/key order;
- signed release document is a fixed-order positional array with an exact schema
  identifier and bounded fields;
- decoding must encode back to byte-for-byte identical input.

The candidate IPC schema remains separate from the signed sender frame. A plugin
cannot submit a pre-signed frame or select the trusted destination.

## Evidence and revision behavior

Eligible evidence is one of:

- `_finnsig`-attested normalized Signal ingress;
- a root-authorized imported source;
- a current `_finnrel`-verified memory projection;
- a tool observation bearing a separately verifiable host/tool receipt.

An OpenClaw/plugin assertion that a tool ran is not external provenance and fails
closed. The frame carries digests, not raw evidence. Exact supporting UTF-8 byte
spans must match a current, same-scope, fresh, non-quarantined record.

The first unsupported candidate may transition to `REVISION_REQUIRED`. Only
revision 1 is then eligible. Remaining unsupported factual claims produce a typed
abstention/denial; timeout, verifier crash, non-English input, overlength input,
and ambiguous evidence all fail closed. Non-factual acknowledgement is a
mechanically constrained envelope class in a later slice, not a model-selected
bypass.

## Durable state and transport guarantee

`_finnrel` retains canonical candidate identity and binding in one ledger. Validation never signs or
sends:

`RECEIVED -> VALIDATED | REVISION_REQUIRED | ABSTAINED | DENIED`

Final release is a separate compare-and-swap over the exact escrowed canonical payload:

`VALIDATED -> FRAME_SIGNED -> DELIVERED | UNKNOWN`

`_finnsig` is the physical-attempt authority:

`RECEIVED -> ATTEMPT_STARTED -> DELIVERED | UNKNOWN`

Candidate acceptance is exactly once for `(candidate_id, turn_ticket, revision)`.
The sender makes at most one automatic attempt. A crash after `ATTEMPT_STARTED`
recovers as `UNKNOWN`; `UNKNOWN` never retries automatically. This does not claim
impossible exactly-once behavior from the external Signal transport. Reconciliation
requires transport-supported lookup bound to the frame before a human-approved
action; absence is not proof of no send.

Capacity exhaustion rejects new rows and never evicts idempotency history.
Bounded archival/reconciliation policy is required before production retention
limits are raised.

## Filesystem and service layout

- `/Library/FunctionalFinn/releases/<hash>/`: root-owned immutable binaries.
- `/Library/FunctionalFinn/policy/`: root-owned policy and `_finnrel` public key.
- `/var/db/functional-finn/release/`: `_finnrel` ledger and mode `0400` key.
- `/var/db/functional-finn/signal/`: `_finnsig` ledger and Signal store.
- `/var/run/functional-finn/release-candidate/`: `_openclaw -> _finnrel` only.
- `/var/run/functional-finn/signal-release/`: `_finnrel -> _finnsig` only.
- `/var/run/functional-finn/signal-ingress/`: `_openclaw` normalized ingress pull.

Dedicated groups grant only directory/socket traversal. Peer UID checks remain
mandatory. `_openclaw` is not a member of the signal-release group.

## Backup, enablement, and rollback gate

Before any live mutation:

1. Hash and back up OpenClaw config, Signal extension artifact, Signal linked-device
   store, relevant ledgers, launchd plists, and current ownership/modes.
2. Write and syntax-check a timestamp-bound rollback script without executing it.
3. Install hash-pinned root-owned binaries/policy/plists while services remain
   unloaded; create `_finnrel` and `_finnsig` as non-login users.
4. Copy/migrate Signal state to `_finnsig` and prove the CLI can operate under that
   UID in an isolated canary. If it cannot, stop: this is an architectural blocker.
5. Revoke the old OpenClaw-owned linked device/session before enforcement. There
   must never be two send-capable owners.
6. As `_openclaw`, prove key read, Signal-store read, sender-socket connect, and
   direct Signal process/credential access all fail. Prove forged, stale, altered,
   replayed, wrong-peer, and oversized frames fail before send.
7. Verify candidate/revision/abstention, success, ambiguous transport, restart,
   no duplicate attempt, normalized ingress, and one rollback rehearsal.
8. Only then load services and enable the OpenClaw submit-only adapter. A single
   necessary gateway restart must be separately approved and observed.

Rollback disables both authority services and leaves all sending disabled. It
preserves ledgers, keys, and Signal state for audit; it does not silently return
credentials to OpenClaw or re-enable the legacy direct-send path.

## Current limitations

The source now contains the destination-binding ledger, normalized ingress,
private `signal-cli 0.14.5` stdio transport, isolated HHEM worker client, and
launchd daemon mains. The TypeScript submit/pull-only adapter and real adapter-level hook-timeout hard
fence are also source-complete; they are not out of slice. No live user/service mutation has occurred.

Remaining blockers are exact-object independent GO; a hash-pinned isolated HHEM bundle; dedicated UID
and launchd install proof; `_finnsig` Signal-credential operation; old OpenClaw linked-device revocation;
negative `_openclaw` access proof; backups and syntax-checked rollback; and an actual local-Qwen canary.
Tool observations without an external host receipt remain intentionally ineligible. No live install or
certification is claimed.
