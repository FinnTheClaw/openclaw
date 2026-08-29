# C05 Failure Replan — Alistar 100-case campaign

The adjacent v1 JSON is a closed 10 scenarios × 10 variants corpus. Expand in
the declared order; `<case>` is `c05-<scenario.id>-<variant.id>`. No case may
be dropped, retried into a pass, replaced with a model stub, or counted without
an installed-agent request ID plus coordinator and backend local-Qwen evidence.

## Preconditions

- The all-disabled modular governor skeleton has passed its own fresh-Alistar
  campaign and is the exact installed base.
- The independently reviewed C05 artifact is selected alone in enforce mode.
- A reviewed installed campaign controller provides only the controlled marker
  fixture and declared restart point; it cannot create, edit, or accept C05
  boundaries.
- Every marker is confined below the JSON `workspaceRoot`, named by the case
  ID, and removed after raw evidence is retained.

## Per-case evidence

Record the corpus case ID, prompt, request/correlation ID, installed package and
module digests, config digest, model requested and selected, coordinator/backend
attestation, tool trace, task and boundary events, plan versions, side-effect
counter, final response, and pre/during/post memory samples. Redact only
credentials; never replace a failed trace with a summary.

## Pass condition

All 100 cases must satisfy every listed expectation. In particular, controlled
crash cases prove one durable recovery (not zero and not N→N+2); dual-current
failure cases prove fail-closed behavior; and controlled mutating failures
prove the marker is never rewritten. Any failure blocks C05 promotion and
leaves the production module disabled.

## Current status

Prepared only. This corpus is not executable until the feature-neutral
production governed-run consumer and its exact installed campaign-controller
interface are independently reviewed. It grants no Alistar or production
credit by itself.
