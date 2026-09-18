# Experiment status: DNI - do not integrate the guidance profile

The guidance-only profile in AGENTS.append.md was tested on Alistar through moira/brain on2026-09-18. It did not improve strict task success: baseline28/30, guidance27/30. It remains an archived experiment, not a deployment recommendation. Do not append it to active workspaces by default.

The results do not establish that the text deterministically caused the regressions. They do establish that this pilot does not justify promotion. Two no-op preference runs rewrote metadata; one status-update run stopped after locating its file. The latter also occurred in baseline and exposed the source-owned continuation defect.

Files:

- compare.py and AGENTS.append.md reproduce the rejected guidance experiment.
- project.py projects raw evidence; it does not decide semantic answer correctness.
- compare-continuation.py: separate24-submission source-only comparison for3630720b at1024output tokens.
- compare-status.py: separate20-submission original status-prompt comparison for3630720b.
- compare-goal-anchor.py: separate20-submission original status-prompt comparison for62c83212.
- compare-six-source.py: separate60-submission six-case comparison for62c83212.
- None of these source-only comparisons loads the rejected guidance profile.
- Source candidates are experimental until actual outcomes demonstrate benefit; code/test completion is not deployment approval.

Raw and summarized evidence lives on Grond under:
`/backup/finnclaw_workspace/openclaw-refresh/reports/reliability-resume-20260918/`

No production gateway, PXE, coordinator configuration, or model launch setting changed.

Latest: candidatec74d3d54 corrects the observed malformed-tool terminal completion path; source-tested/built/staged, NOT live-qualified or promoted. compare-malformed-finalization.py is the prepared20-submission comparison versus62c83212, not yet run. RESULTS-20260918.md records completed cohort results and limits.
