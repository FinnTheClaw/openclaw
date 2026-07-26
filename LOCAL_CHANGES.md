# Finn OpenClaw frozen base

This branch is the authoritative OpenClaw source base for Finn and Jake. It is
frozen at source commit `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`,
corresponding to the `2026.7.1` source used by the installed
`openclaw@2026.7.1-2` runtime.

## Ownership

- This repository is persistent and locally authoritative.
- `/Users/aiapi/workspace/openclaw-upstream` is the only disposable upstream
  mirror. Weekly maintenance may hard-reset and clean that mirror.
- Weekly maintenance must never merge, rebase, reset, or otherwise mutate this
  frozen repository.
- `local-overlay/` contains the complete durable patch registry currently
  applied to Finn and packaged for Jake.
- The canonical deployable artifact and its SHA-256 are recorded in
  `OPENCLAW_FREEZE.json`. Large runtime artifacts remain outside Git.

## Selected upstream integration

An upstream change is integrated only after the user selects it from a weekly
audit report. Create a candidate branch from this frozen branch, port or
cherry-pick the selected change, reconcile every overlapping local change,
and run the targeted plus full regression suites. Do not change the canonical
artifact, freeze manifest, Finn, Jake, or the stable update manifest until the
candidate has a written compatibility report and explicit promotion approval.

Direct fast-forwarding from upstream, automatic dependency upgrades, and
runtime-bearing agent updates are prohibited.
