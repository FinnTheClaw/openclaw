# Behavior governor gateway shadow runbook

This integration is disabled unless the typed `experimental.behaviorGovernor.enabled` value is
explicitly true. An absent or disabled value is a legacy path: it does not load heavyweight
governor host/bootstrap/state modules, resolve governor secrets, open governor state, install a
host, or change tools, replies, or continuation. A tiny inert runner registry remains statically
available so the disabled path can resolve to no governor scope without importing the host.

## Configuration and restart boundary

Use the typed config surface with `mode: shadow` and canonical `SecretRef` objects. Do not place
secret values in the config, and do not provide module paths, functions, commands, URLs, adapter
objects, or registry selectors. Canonical startup snapshot preparation resolves the refs once;
the lifecycle consumes the already-resolved narrow values from that immutable snapshot without
provider re-execution, then passes an immutable secret bundle to the trusted host factory.
Governor state is kept below the
canonical state root in its dedicated `governor` directory.

Changes to governor policy while a runtime is active are restart-required. A secret-provider
refresh is not hot-applied: because this slice receives the snapshot generation only when the
gateway applies governor config, an operator gateway restart is required before a rotated
governor key is used. The lifecycle must retain the old generation and return
`GOVERNOR_GATEWAY_RESTART_REQUIRED` for an observed active-config change; it must not close the
old runtime and install a partially validated replacement. Shutdown drains scopes, revokes owner
capabilities and delivery handles, closes the governor database/ledger, and then releases the
runtime. A close failure is retained and must fail the gateway restart path closed.

## Shadow assertions

Shadow records bounded private decisions and audit observations only. It must not steer or remove
steering, stop or interrupt the provider, replace tools, block a native tool, change arguments or
results, suppress completed-message retries, or claim verified completion. Observation wrappers
may be installed around hooks, but pre-existing hook invocation/order and the final transformed
result/error must remain unchanged. A terminal
shadow observation is explicitly not task completion. Compare an absent-governor run with a shadow
run for successful, failed, cancelled, post-hook-modified, and exact-retry inputs; visible behavior
must match while only private governor observations may differ.

Enforce mode and real read-only tool bindings require a separately reviewed compiled host registry,
implementation attestation, owner bindings, and provisioned non-production secrets. This document
does not authorize activation, deployment, live channels, or a canary. The final acceptance gate
must also prove that the inert runner registry keeps the heavy host bootstrap out of the OFF
module-load graph.
