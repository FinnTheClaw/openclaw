# ADR: C07 general plugin process boundary

Status: proposed amendment. C07 enforce remains unconditionally unavailable until every gate in
this record and the accepted C07 companions is proven. This record authorizes only the staged
implementation work described below; it does not authorize activation or deployment.

Normative basis: the accepted C07 design at `e4cc9c4286d`, including
`ADR-C07-memory-authority-redesign.md`, `ADR-C07-memory-authority-protocol.md`,
`ADR-C07-memory-migration-acceptance.md`, and `ADR-C07-memory-writer-inventory.md`.

Negative evidence only: the process-boundary implementation present at `e613b336bc6` is a rejected
prototype. Its source is not an implementation base and must not be copied or ported. It showed why
a child-reported identity, Node `process.send`, an entry-file-only digest, and a mutable or late
activation check do not establish the accepted boundary. The earlier accepted design at
`e4cc9c4286d` remains normative.

## Decision

C07 requires a general plugin-host boundary, not a memory-specific worker. When C07 enforce is
eventually available, the trusted gateway supervisor will evaluate no plugin module and retain no
plugin callable. Every installed, workspace, and bundled module that remains classified as a plugin
runs in a separate process under the restricted plugin OS identity. The C07 authority, recall gate,
and LanceDB projection become compiled supervisor subsystems and are no longer plugin surfaces.

The supervisor owns manifests, policy, authoritative context, routing, network listeners, secrets,
and durable authority. A plugin host receives only its attested package closure, declared
capabilities, bounded invocation input, and narrowly typed host capabilities. It returns untrusted
descriptors or invocation results. No JavaScript object, closure, factory, database handle, socket
handle, module path, authority key, or C07 operation crosses into plugin code.

OFF and shadow preserve their accepted behavior and do not import, start, connect to, or persist
this boundary. Partial implementation never weakens the current unconditional enforce interlock.

## Why this is one boundary

Moving only memory-lancedb would leave arbitrary plugin top-level code and registered callbacks in
the supervisor. Such code could still reach process globals, imported core state, secrets, and
same-process factories. A special `invoke(payload)` worker would hide that unresolved authority
behind a second path and invite repeated partial fixes.

The root fix is therefore one migration of the plugin execution model:

1. trusted code reads signed, static manifest data without evaluating plugin code;
2. a platform adapter establishes and attests a restricted process and channel;
3. the worker evaluates the complete attested package only after restriction and attestation;
4. registration produces data descriptors plus typed callback handles, never supervisor callables;
5. runtime dispatch uses a closed operation for the descriptor's exact category; and
6. revocation destroys the channel, handles, pending work, and exact process generation together.

No category may retain an in-process compatibility path in enforce. A plugin surface without a
bounded wire contract is unavailable and blocks enforce readiness; it does not fall back.

## OS principal and artifact prerequisites

Provisioning is the only root-owned phase. The steady supervisor is non-root. Every mutually
untrusted plugin package has a unique provisioned UID and primary GID; identities are shared only by
packages in one explicitly signed trust domain. A generation never changes identity or files in
place. Runtime setuid from Node, `sudo`, a shell launcher, and a caller-selected UID are rejected.

The installed generation is immutable until verified worker exit. A signed build manifest contains
a canonical Merkle digest of the fixed bootstrap, plugin manifests and entries, every resolved
JavaScript dependency, native module, and allowed runtime-data file. Root owns every file and
ancestor. Resolution is fd-relative and no-follow; it rejects symlinks, hard-link aliases, writable
ancestors, undeclared imports, and generation substitution. Old generations remain mounted and
hash-verifiable until all of their workers reach `EXIT_VERIFIED`.

Authority, state, projection, and key directories are supervisor-owned `0700`; files are `0600`.
No plugin UID can traverse them. The plugin receives no inherited descriptor except its exact
activation channel and declared package files.

## Linux provisioned unit and identity chain

Root provisioning installs one root-owned immutable `.socket`/`.service` pair for each package and
generation. The socket uses `ListenSequentialPacket=`, `Accept=no`, `PassCredentials=yes`,
`Backlog=1`, `FlushPending=yes`, `RemoveOnStop=yes`, and a root-owned path whose dedicated group/mode
permits only the supervisor UID to connect. The service uses `Restart=no`, the package's unique
non-root `User=`/`Group=`, an empty
supplementary-group set, and fixed root-owned `ExecStart=`. PID1 passes the listening sequential-
packet socket as activation fd 3. Before liveness, the trusted bootstrap validates fd 3 as the
expected listener, closes every unexpected inherited fd, sets `PR_SET_DUMPABLE=0`, confirms core
dumps are disabled by unit `LimitCORE=0`, calls `accept4` exactly once, `dup3`s the accepted channel
to fixed fd 4 with `O_CLOEXEC` when distinct (otherwise verifies fd 4 is `CLOEXEC`), closes the
original accepted fd when distinct and listener fd 3, and retains only fd 4 plus declared closure
fds. No caller can select unit, executable, UID, package, or generation.

Before `connect`, the supervisor creates its client socket, sets `SO_PASSCRED=1`, and confirms it
with `getsockopt`; it then connects only to the signed root-owned path. The bootstrap confirms the
channel fd 4 has `SO_PASSCRED=1` by set/get, pins supervisor `SO_PEERCRED`, and only then emits
liveness. It receives `KEY_INSTALL` by `recvmsg` exactly once and requires an untruncated 80-byte
packet with one `sizeof(struct ucred)` kernel credential matching the pinned UID/GID/PID and no
other ancillary. Thereafter both endpoints use `sendmsg` with no user ancillary; each endpoint uses
`recvmsg` for every peer frame, including the supervisor for every worker frame, with
`MSG_CMSG_CLOEXEC` and a control buffer exactly
`CMSG_SPACE(sizeof(struct ucred))`. Each receive requires `MSG_TRUNC=0`, `MSG_CTRUNC=0`, exactly one
`SOL_SOCKET`/`SCM_CREDENTIALS` header whose length is `CMSG_LEN(sizeof(struct ucred))` and whose
PID/UID/GID match the pin, and no other header. Any received descriptor is closed before revocation.

The supervisor takes the liveness packet's kernel SCM PID, immediately opens a pidfd, and binds it
to D-Bus `MainPID`, invocation ID, fixed unit object path, exact cgroup, readable
`/proc/<pid>/stat` start ticks, and host boot ID. It rereads PID/start/unit/cgroup bindings before key
delivery. The signed deployment manifest names and hashes the root-owned unit fragment/drop-ins,
configured `ExecStart`, bootstrap, read-only closure, UID/GID/groups, capability set,
`NoNewPrivileges`, namespaces, syscall policy, resource limits, and socket properties. The
supervisor hashes those configured artifacts and trusts PID1 to execute the fixed configuration; it
does not claim cross-UID access to `/proc/<pid>/exe`, runtime sandbox internals, or child-reported
identity.

The 32-byte channel key is delivered only after these proofs pass. The reviewed hash-attested
bootstrap is part of the TCB: it installs Landlock and the final sandbox, reconfirms non-dumpable
state, then sends authenticated `SESSION_READY`. That frame proves only that the fixed bootstrap
reached that code; hostile extracted-package tests prove sandbox behavior. Plugin bytes load only
after an authenticated `LOAD_PACKAGE` arrives.

On every platform the supervisor creates each key once with the OS CSPRNG after attestation. Both
ends accept/install it exactly once, retain it only in non-dumpable process memory, keep every
channel fd `CLOEXEC`, and
never place it in environment, argv, file, log, diagnostic, crash/core output, or child report. They
zeroize their key buffers after revocation/close and verified exit; a repeated key packet revokes.

The pidfd is for liveness/exit only. Every cleanup first fences and stops the exact socket unit,
flushes its backlog, and proves it inactive with path absent. Normal shutdown then drains/closes fd 4;
a fault revokes it immediately. Both paths stop the exact service. `EXIT_VERIFIED` requires both
units stopped, path absent, pidfd ready, `MainPID=0`, and cgroup empty. Generation N+1 waits for
verified N exit; uncertainty puts the whole plugin host in `RECOVERY_REQUIRED`.

The readiness manifest hashes the low-level authorization policy path, content, D-Bus interface and
member, exact socket/service object paths, and polkit unit/verb details. It grants only
`org.freedesktop.systemd1.Unit.Stop` on those two objects: no manager/wildcard stop, start, restart,
signal, property mutation, or other unit.

## Linux pre-import sandbox

systemd owns externally attestable filesystem, mount, network, device, namespace, resource, group,
capability, core, and `no_new_privs` restrictions. After key install, the fixed bootstrap preopens
only the signed closure and installs final Landlock/seccomp before `SESSION_READY`.

The final policy denies `execve`/`execveat`, `fork`/`vfork`, `clone3`, nonthread `clone`, ptrace,
process-vm, `pidfd_getfd`, namespace/mount creation, `socket`, `socketpair`, `socketcall`, `connect`,
`accept`, `accept4`, `io_uring_setup`, `io_uring_register`, `io_uring_enter`, `sendmmsg`, and
`recvmmsg`.
Seccomp permits `sendmsg`/`recvmsg` only when argument fd equals 4 and denies them on every other fd;
the supervisor rejects any attempted rights/ancillary transfer, self-revoking that worker without
creating a delegation channel. `ProtectProc=invisible`, `ProcSubset=pid`, private PID namespace,
cgroup `TasksMax`, and the
read-only closure prevent process discovery and undeclared module/native/executable loads. Any
category that needs a forbidden syscall receives a separate typed supervisor capability or remains
unsupported; the sandbox is not relaxed per request.

Linux proof executes hostile fixtures for direct and io_uring socket/connect/accept, `sendmmsg`/
`recvmmsg`, fd-4 close/reuse, every denied process syscall, ptrace/process-vm access, pidfd theft, fd
inheritance and `SCM_RIGHTS`, `/proc` escape, writable/symlink/hard-link replacement, undeclared
JavaScript/native/ELF load, package change during hashing, cgroup/PID reuse, extra connection, and
post-revocation reuse. The disposable-root test inspects the extracted artifact's installed seccomp
policy and proves that no socket except attested fd 4 exists after `SESSION_READY`. It also proves
allowed runtime threads and every accepted plugin category work within fixed task and memory bounds.

## macOS launchd raw Mach boundary

Root provisioning installs one immutable LaunchDaemon raw Mach service per package/generation under
its unique non-root account, with `KeepAlive=false`, unique label, fixed bootstrap/closure, root-owned
sandbox, task/memory limits, and Mach queue limit 64. The worker owns the launchd service receive
right; the supervisor obtains its send right and creates one private reply receive right. Before any
application packet, the supervisor sends one transport-only `PORT_INSTALL` message: fixed message ID
`0x4f435049`, the complex bit, no inline body, and exactly one `COPY_SEND` descriptor transferring the
reply-port send right. The worker first verifies that message's audit token, code requirement, and job
identity. Every later message on both ports is simple and inline: no complex bit, descriptor, OOL
memory, additional right, fileport, fd, proxy, or executable object.

Native `mach_msg` receives into one fixed compile-time buffer sized as Mach header plus the exact
1,048,704-byte blob cap plus audit trailer. `MACH_RCV_TOO_LARGE` is rejected before application
allocation. Every worker-to-supervisor message arrives on the reply receive port; every
supervisor-to-worker message arrives on the service receive port. Before accepting inner bytes,
each receiver verifies the audit-token trailer, UID/GID/PID, launchd job/label, boot session,
`proc_pidinfo` lifetime, fixed-bootstrap code requirement, and package code/closure binding.

After `PORT_INSTALL`, the worker sends `BOOTSTRAP_LIVE` on the reply port; only after its OS proof
may the supervisor send `KEY_INSTALL` on the service port. Each inline application blob is exactly
the corresponding Linux bootstrap packet or authenticated frame; lengths, HMAC bytes, sequences,
and validation order are identical. Wrong port, trailer, identity, code, rights, size, direction, or
job exit revokes all handles. The sandbox denies fork/exec, task/ptrace/process-memory
access, other Mach lookup/register, right delegation, undeclared code loads, and supervisor/C07
paths. A replacement waits for verified job/port destruction or enters `RECOVERY_REQUIRED`.

Disposable-root extracted-package tests cover identity/code substitution, oversize-before-copy,
complex/OOL/right messages, queue exhaustion, fork/exec/task/delegation denial, invalidation races,
exact exit, and generation reuse. Linux evidence and mocked Mach/proc results are non-countable.

## Explicitly rejected channels and attestations

The following never satisfy C07 readiness:

- anonymous or named pipes, stdin/stdout framing, Node IPC, or `process.send`;
- TCP, loopback HTTP, WebSocket, or bearer-token-only local RPC;
- child-reported PID, UID, GID, groups, executable, digest, or restriction state;
- a one-time `/proc` or `proc_pidinfo` check without held process identity and continuing
  per-frame credentials or audit-token-trailered Mach messages;
- hashing only an entry file, `package.json`, or mutable directory snapshot;
- importing a module and attempting to sandbox its callbacks afterward; or
- accepting a same-UID worker, same-process factory, hidden export, closure, symbol, or WeakSet as a
  trust boundary.

## Frame and session protocol

### Bootstrap packets

Before a key exists, exactly two fixed binary packets are allowed. All multibyte integers are
unsigned big-endian.

- `BOOTSTRAP_LIVE` is 32 bytes: ASCII `OCB0` at 0-3, version `1` at 4-5, kind `1` at 6, and zero at
  7-31. It is child-to-supervisor only, constant, unauthenticated, non-replay-sensitive, and carries
  no PID, UID, package, readiness, or restriction claim. Only per-packet kernel credentials make it
  useful as a liveness trigger for OS attestation.
- `KEY_INSTALL` is 80 bytes: ASCII `OCK0` at 0-3, version `1` at 4-5, kind `2` at 6, zero at 7,
  16-byte channel ID at 8-23, 16-byte supervisor boot epoch at 24-39, uint64 generation at 40-47,
  and the 32-byte random HMAC key at 48-79. It is supervisor-to-bootstrap only after completed
  attestation. The bootstrap accepts it only from the pinned Linux fd 4 or Mach-port peer.

Any other pre-key byte, length, order, peer, retry, or second packet revokes the instance. Key
installation is not readiness. The trusted bootstrap installs the final sandbox, then emits the
authenticated `SESSION_READY`; it cannot import the plugin until authenticated `LOAD_PACKAGE`.

### Authenticated v1 frame

One sequential packet contains one 128-byte header followed by its body. Byte order is big-endian.
The layout is frozen:

| Offset | Width | Field                                                                    |
| -----: | ----: | ------------------------------------------------------------------------ |
|      0 |     4 | ASCII magic `OCPB`                                                       |
|      4 |     2 | protocol version, exactly `1`                                            |
|      6 |     1 | closed frame kind                                                        |
|      7 |     1 | flags, exactly zero in v1                                                |
|      8 |     4 | body-codec/schema ID, exactly zero in the raw slice                      |
|     12 |     4 | body byte length                                                         |
|     16 |    16 | channel ID                                                               |
|     32 |    16 | supervisor boot epoch                                                    |
|     48 |     8 | child generation, starting at `1`                                        |
|     56 |     8 | sender-direction sequence                                                |
|     64 |    16 | request ID, or all zero where prohibited                                 |
|     80 |     8 | absolute `CLOCK_MONOTONIC` nanosecond deadline, or zero where prohibited |
|     88 |     8 | reserved, exactly zero in base v1                                        |
|     96 |    32 | HMAC-SHA-256 tag                                                         |

The tag uses the exact 32-byte channel key over header bytes 0-95 followed by the untouched body.
Each direction starts at sequence `1`; duplicates, gaps, zero, and out-of-order frames revoke.
Usable sequences end at `2^64-2`; `2^64-1` is an exhaustion sentinel that is never emitted or
accepted. Reaching it fences new work and drains if the supervisor can still send, otherwise it
performs exact stop; no direction wraps. Channel, boot, and request IDs are random supervisor-made
128-bit values. Lifecycle and registration kinds require zero request ID/deadline. `INVOKE`,
`RESULT`, and `CANCEL` are request-bearing, repeat one nonzero retained ID/deadline, and `INVOKE`'s
deadline must be future monotonic time no more than 300 seconds away. Only the retained deadline is
authoritative; a different carried value revokes rather than extending it.

Kinds are `0x01 SESSION_READY`, `0x02 LOAD_PACKAGE`, `0x03 REGISTER`,
`0x04 REGISTER_DONE`, `0x05 REGISTER_ACCEPT`, `0x10 INVOKE`, `0x11 RESULT`,
`0x12 CANCEL`, `0x20 DRAIN`, `0x21 CLOSE_ACK`, and `0x7f FATAL`. Direction and legal session state
are fixed by the transition table; an unknown or misplaced kind revokes.

Supervisor-to-worker-only kinds are `LOAD_PACKAGE`, `REGISTER_ACCEPT`, `INVOKE`, `CANCEL`, and
`DRAIN`; worker-to-supervisor-only kinds are `SESSION_READY`, `REGISTER`, `REGISTER_DONE`, `RESULT`,
`CLOSE_ACK`, and `FATAL`. Base v1 has no credit or streaming frame and no active flow-control
semantics. Streaming categories remain unsupported.

The raw slice authenticates bodies as opaque bytes, returns owned non-aliasing copies of every
decoded byte field, and does no CBOR or semantic-schema decoding.
Header schema ID is zero in that slice. `SESSION_READY`, `LOAD_PACKAGE`, `REGISTER_DONE`,
`REGISTER_ACCEPT`, `CANCEL`, `DRAIN`, `CLOSE_ACK`, and `FATAL` require an empty body. The fixed unit
already selects the package/generation. The absolute body cap is 1,048,576 bytes; `REGISTER` is
262,144 per packet and 4,194,304 total, and `INVOKE`/`RESULT` are 1,048,576. A plugin may register at
most 4096 descriptors. Lower signed manifest limits are allowed; runtime/config cannot raise them.

`recvmsg` uses a 1,048,704-byte fixed cap and `MSG_TRUNC` to learn packet size without allocation.
It rejects truncation, wrong exact packet/body length, header values, peer credentials, sequence,
reserved bytes, or request binding before verifying HMAC in constant time. Work is bounded by the
verified effective kernel send/receive buffer cap of 4,194,304 bytes each, 64 queued frames,
4,194,304 queued bytes, and 32 in-flight invocations.
`CANCEL` is admitted only for a pending request or terminal-grace tombstone and `FATAL` only once per
generation. They bypass ordinary queue accounting using exactly 32 cancellation slots plus one
fatal slot and a separate `33 * 128 = 4224` byte reserve; bodies stay empty and HMAC/sequence applies.

### Session and cleanup state machine

| State          | Accepted event                                     | Required action and next state                                                                    |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NEW`          | systemd/Mach connection                            | Pin expected package/generation; `ATTESTING`.                                                     |
| `ATTESTING`    | exact liveness plus complete OS/package proof      | Deliver key; `KEYED`. Any mismatch revokes.                                                       |
| `KEYED`        | valid `SESSION_READY` plus verified final sandbox  | Send `LOAD_PACKAGE`; `LOADING`.                                                                   |
| `LOADING`      | first `REGISTER`                                   | Enter `REGISTERING`; no runtime dispatch.                                                         |
| `LOADING`      | `REGISTER_DONE`                                    | Compare the valid zero-registration inventory, return `REGISTER_ACCEPT`; `ACTIVE`.                |
| `REGISTERING`  | one-descriptor `REGISTER` or final `REGISTER_DONE` | Retain one descriptor, or compare inventory and return `REGISTER_ACCEPT`; `ACTIVE` only on final. |
| `ACTIVE`       | valid invoke/result/cancel                         | Apply exact context, deadline, and quota rules; remain `ACTIVE`.                                  |
| `ACTIVE`       | shutdown/update/sequence drain                     | Fence local work; on Linux stop/verify socket unit; send `DRAIN`; `DRAINING`.                     |
| `DRAINING`     | matching terminal/local cancel/timeout             | Complete only already-pending work and grace accounting; remain `DRAINING`.                       |
| `DRAINING`     | `CLOSE_ACK` and no pending work                    | Close channel and stop fixed service/job; `STOPPING`.                                             |
| `DRAINING`     | five-second grace expires                          | Reject pending once, force close and exact service/job stop; `STOPPING`.                          |
| any live state | protocol/identity/package/process fault            | Fence ingress, revoke handles/pending, close, exact stop; `STOPPING`.                             |
| `STOPPING`     | complete transport/process exit proof              | Release generation only after every platform condition agrees; `EXIT_VERIFIED`.                   |
| any live state | cleanup or identity uncertainty                    | Fence the whole host; `RECOVERY_REQUIRED`.                                                        |

`EXIT_VERIFIED` and `RECOVERY_REQUIRED` are terminal. Cleanup is idempotent and records whether
ingress/path, handles, pending work, channel, service/job, pidfd/port, unit state, and cgroup were
completed; a closed channel is not process exit. Worker sends `CLOSE_ACK` only after `DRAIN`, after
rejecting new work and reaching zero pending; early/duplicate ACK revokes.

Local accounting events are closed: `ACQUIRE_INVOKE` reserves one unique pending slot below 32;
`QUEUE_FRAME` reserves one frame and its exact bytes below both queue caps; `PROCESS_FRAME` releases
that queue reservation exactly once; and `TERMINAL` CASes result, local cancel, or timeout, releases
the invocation exactly once, and retains only a two-second terminal-grace tombstone when a cancel or
late result may still cross. Invalid transitions cannot acquire or release resources.

Deadline expiry is a normal request terminal outcome, not by itself a session fault. Local cancel or
timeout wins the same single-terminal CAS as a valid result, releases its invocation once, creates
the terminal-grace tombstone, and sends exactly one reserved-slot `CANCEL` against it. One losing
matching terminal frame is discarded and counted during that tombstone's two-second grace. A
duplicate terminal, continued request traffic, wrong request, or traffic after grace revokes; no
losing path reports success or releases resources twice.

The raw FSM counts one registration per `REGISTER` frame and consumes a host-local
`inventoryMatches` result at `REGISTER_DONE`; this is a model boundary, not semantic wire proof.
FSM tests cover zero, one, and 4096 frames; 4097, mismatch, and post-done registration revoke.

## Context confinement

The supervisor retains plugin ID, package digest, callback category, agent/session/scope, tool or
capability name, authorization decision, request sequence, deadline, cancellation state, and
resource budget. The worker receives an opaque request ID and the minimum category-specific input.
It cannot supply or override retained context in a result or reverse call.

Every host operation is a closed typed capability bound to the current plugin, registration handle,
invocation, and manifest declaration. Results are data only. There is no `invoke(method, args)`,
`call(functionName, payload)`, arbitrary property access, module loading, eval, callback pass-through,
or generic runtime proxy. `runtime.gateway.request` and transfer of the full `api.config` or
`api.runtime` object are explicitly forbidden. The worker gets a redacted category-specific config
slice and named capabilities only. Unknown operation IDs and handle/category mismatches revoke.

Plugin-owned external credentials and state, when a category genuinely needs them, use an explicit
least-privilege broker or separately confined resource named in that category's contract. They
never grant access to governor secrets, supervisor state, other plugins, or C07 RPC.

## Registration and callback migration

Plugin evaluation and `register(api)` happen only in the worker. The worker's registration API
serializes immutable descriptors. For each callable field, the worker retains the function and the
supervisor returns an opaque host-assigned handle bound to plugin ID, package digest, child
generation, registration sequence, exact callback category, and manifest contract. The supervisor
registry stores a category-specific proxy for that handle, not the original function.

Proxy results cannot introduce executable values or new generic handles. Dynamic subscriptions,
streams, and lifecycle callbacks need their own typed create/use/cancel/close protocol and quotas.
Handles are nontransferable across plugins, categories, processes, reloads, requests, and boot
epochs. Worker exit or revocation invalidates them synchronously before any replacement registers.

The generated inventory starts at `OpenClawPluginModule` and definition fields such as
`register`, `activate`, `reload`, `nodeHostCommands`, `securityAuditCollectors`, and `configSchema`
(`src/plugins/types.ts:2404`), then recursively walks every `OpenClawPluginApi` member
(`src/plugins/types.ts:2628`), including full config/runtime graphs, grouped and flat aliases,
callbacks nested in arguments or returns, reverse host calls, and dynamically returned handles. It
also walks every `full`, `discovery`, `tool-discovery`, `setup-only`, `setup-runtime`, and
`cli-metadata` loader path; setup/CLI/discovery/config-validation entries; direct module evaluation
in `src/plugins/loader.ts:2480`; every registry member (`src/plugins/registry-types.ts:442`); and all
global or side registries. Each leaf has exactly one disposition: signed static data, one typed
descriptor/handle proxy, compiled core, or unsupported-and-blocking. Exact symbol/schema inventory
replaces prefix allowlists. Unvisited union members, callback returns, aliases, and runtime additions
fail generation and readiness.

At minimum, the inventory and parity suites cover:

| Category                                                                                                                | Required migration shape                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools, commands, hooks, policies, middleware                                                                            | Typed descriptors and one exact handler handle; host retains authorization and invocation context.                                                                                                        |
| Gateway methods, HTTP routes, hosted media, interactive handlers                                                        | Supervisor terminates network/auth; worker receives bounded request data or typed body chunks and returns typed response operations. No `IncomingMessage`, `ServerResponse`, `Duplex`, or socket crosses. |
| Channels and setup                                                                                                      | Static setup metadata plus typed channel lifecycle, ingress, action, and egress protocols. No setup/runtime entry evaluates in the supervisor.                                                            |
| Model, embedding, speech, transcription, voice, media, web, and catalog providers                                       | Per-provider-method handles with declared schemas, bounded streams, deadlines, cancellation, and brokered plugin-owned credentials.                                                                       |
| CLI, node, migration, reload, audit, discovery, and services                                                            | Declarative command/service descriptors plus typed lifecycle or operation handles. Commander registrars and service objects remain in the worker.                                                         |
| Harness, context, compaction, detached-task, memory-adjacent, session, run-context, lifecycle, and agent-event surfaces | Dedicated schemas preserving the host-owned scope and lifecycle; the C07 authority/projection itself is compiled core and exposes no plugin handle.                                                       |

Tests must prove semantic parity for every accepted inventory entry. A broad adapter that can call
arbitrary object methods is not a migration and fails the inventory gate.

## Gateway ordering correction

The current gateway prepares plugin bootstrap at `src/gateway/server.impl.ts:699`, including a
setup-runtime loading path, while governor application occurs at `src/gateway/server.impl.ts:1254`;
the loader evaluates modules at `src/plugins/loader.ts:2480`. The unconditional enforce rejection
contains this defect today. It cannot be removed while that order or any global callback survives.

Enforce startup and restart therefore use this order:

1. parse core config and signed static manifests/generated JSON Schemas; derive the immutable boot
   decision and verify architecture, inventory, package, unit/job, and adapter proofs without plugin
   evaluation or secrets;
2. retire and purge every process-global plugin callback, imported-plugin marker, registry, hook,
   service, provider, command, loader cache, and side registration; any remaining callable fails;
3. load secrets and reconcile authority, external anti-rollback state, projection, and migration,
   then publish internal-only `AUTHORITY_READY`; no listener or plugin exists yet;
4. establish each OS host, complete attestation, deliver its key, verify authenticated ready and
   final sandbox, then send `LOAD_PACKAGE`;
5. collect descriptors into an unattached registry, compare the exact signed recursive inventory,
   and reject the entire generation on any missing, extra, or schema-mismatched leaf;
6. attach only typed proxies, start bounded plugin lifecycles, and publish final `ENFORCE_READY`; and
7. only then expose listeners, governed work, model calls, tool dispatch, and external readiness.

Metadata-only planning may read signed manifest data in step 1. It may not load setup, CLI,
channel, discovery, config-schema, or other executable plugin entries. Enforce treats plugin install,
enablement, package, schema, or inventory change as restart-only and rejects in-process plugin
reload. Gateway shutdown revokes the old generation; the replacement becomes available only after
the complete startup sequence succeeds.

## Staged implementation

### C07a.2.1: raw codec and session model only

The first slice implements only transport-independent raw frame encoding/decoding and a pure session
state machine. It creates no socket or process, loads no module, reads no config or secret, exposes no
plugin API, writes no state, changes no gateway path, and cannot affect OFF, shadow, or enforce.

Target files and non-comment, nonblank ceilings:

- `src/plugins/process-boundary/frame-codec.ts`: 280 lines;
- `src/plugins/process-boundary/session-fsm.ts`: 260 lines;
- `src/plugins/process-boundary/frame-codec.test.ts`: 500 lines; and
- `src/plugins/process-boundary/session-fsm.test.ts`: 500 lines.

The codec tests cover every offset and byte order, exact lengths, truncation, cap boundaries,
opaque-body preservation and post-MAC caller-mutation isolation, bodyless-control rejection, MAC
mismatch, kind/flag/direction rejection, and no body inspection before authentication. FSM tests cover
duplicate/gap/wrap,
wrong-generation, nonpending, expiry, queue/byte/in-flight exhaustion, cancellation/result races,
revocation, drain, close, and restart isolation. These are unit proofs only and make no OS-boundary
or body-schema claim.

### C07a.2.2: Linux identity and channel adapter

Add the root-provisioned per-package/generation systemd units, fixed bootstrap, minimal native
`SOCK_SEQPACKET` adapter, and TypeScript owner. Prove fd 3 activation, per-packet credentials,
unit/cgroup/pidfd/start/boot and configured `ExecStart`/bootstrap-artifact/closure binding,
pre-import sandbox, exact socket/service stop and exit, and malicious frames on a disposable root
Linux host. Only signed hostile proof fixtures load after authenticated ready; no OpenClaw
registration, authority, or gateway path is enabled.

### C07a.2.3: macOS identity and channel adapter

Implement only the launchd raw Mach adapter and prove job/account, audit-token trailers, code and
closure binding, sandbox, rights rejection, port invalidation, and exact exit on a disposable root
macOS host. No alternate transport or mock can close this slice.

### C07a.2.4: body codecs and flow control

Separately review and pin the body codec before semantic dispatch. It must freeze every schema ID,
kind/body pairing, decoder limit, and canonical byte rule. If RFC 8949 is selected, the amendment
must name the exact deterministic profile and map-key ordering rather than infer one. The reviewed
implementation, exact version, dependency/lockfile, supply-chain record, and extracted-package
digest enter readiness. Streaming remains unsupported until this slice defines separately reviewed
kinds/version, buffers, cancellation, flow-control counters, wrap thresholds, and hostile tests.

### C07a.2.5: registration inventory and typed proxies

Generate the exact current callback/writer inventory, define one bounded schema per accepted
category, migrate registration and dispatch category by category, and prove parity plus negative
cross-category tests. Delete replaced in-process paths in the same slice. Unsupported categories
remain explicit readiness blockers.

### C07a.2.6: gateway integration and release proof

Apply the startup ordering above, bind the generated inventory and both native adapters into the
signed build/readiness manifest, verify the extracted npm package rather than a source checkout, and
run OFF/shadow byte-for-byte A/B tests. Run the accepted 100 malicious-plugin schedules and all C07
deterministic prerequisites. Only an independent zero-P0/P1 review plus Linux and macOS disposable-
root proofs may change C07a.2 from incomplete.

## Enforcement gate

C07 enforce remains hard-coded unavailable until all of the following are true together:

- the exact generated plugin and memory-writer inventories have no unknown or in-process callable;
- the pinned body codec, every category schema, and required streaming/flow-control protocol have
  exact caps, cancellation, revocation, wrap, supply-chain, extracted-package, and parity proof;
- Linux and macOS adapters pass their real disposable-root suites from extracted release artifacts;
- the gateway ordering correction and restart-only update rule are proven;
- OFF/shadow perform no boundary import, spawn, socket, durable write, or behavior change;
- the signed readiness manifest binds protocols, native binaries, package closures, inventories,
  test evidence, and accepted C07 architecture versions; and
- independent review reports zero P0/P1 findings.

No feature flag, config value, plugin response, test injection, environment variable, or partial
manifest may bypass this gate. Until then, the only honest state is design or source-slice complete,
never deployable or enforce-ready.

## Anti-ping-pong rule

Each slice must remove one ownership ambiguity and its obsolete path. Findings are resolved at the
shared invariant, then tested across every sibling category named by the inventory. Do not add
special memory workers, secondary protocols, compatibility fallbacks, guard chains, or
platform-generic claims. If a later slice invalidates a prior proof, regress its status and repair
the owning boundary before proceeding.
