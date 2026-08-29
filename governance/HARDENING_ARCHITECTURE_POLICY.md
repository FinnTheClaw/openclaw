# Hardening architecture exclusion policy

The governor has one durable authority per domain. A change must extend the listed
owner boundary; it may not introduce a second memory, queue/lifecycle, child-slot,
finalizer, cursor, or transcript owner.

`governance/hardening-dni.json` records reviewed direct-transplant rejections.
The release gate rejects an exact upstream SHA and a stable patch-id equivalent.
It also validates each record against the durable-owner inventory and runs the
existing host-import and durable-persistence structural scans.

Manual or partial copies cannot be detected perfectly from a diff fingerprint.
The structural scans catch new durable database authority and forbidden host imports;
ownership review remains required for code that avoids those observable shapes.

DNI records are append-only. A reconsideration appends a reviewed supersession that
references the rejection, reviewed commit, reason, and immutable audit evidence.
It never edits or removes the original rejection or its evidence binding.

Clean-room semantic reuse is allowed only when the record explicitly says so. It is
an independently implemented assertion or test; no rejected source, test, prompt,
or schema code is copied. The DNI and structural checks are release inputs, not
runtime guards.
