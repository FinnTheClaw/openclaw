# Coordinator-first profile

Opt-in operator profile for the Refresh frozen build. Uses the existing native subagent runtime; no plugin, tool restriction, extra retry loop, or new scheduler.

Merge `config.fragment.json` into the gateway configuration without replacing other keys. Append `AGENTS.append.md` once to the configured workspace's AGENTS.md. Preserve existing workspace content. Apply at a settled turn boundary; new sessions receive the guidance.

The root coordinates and delegates substantive tools, including single-step work. Leaf workers execute directly. Parent coordination tools and root-only capabilities remain usable. Workers inherit the configured local model; this profile does not select a provider or backend.

The native runtime already exposes subagents when effective tools permit spawning. Verify through a real parent -> child tool -> parent completion roundtrip, not only the config schema. Existing native concurrency and depth settings are unchanged; this profile does not promise unlimited throughput or enforce delegation.

Rollback: remove only the marked workspace block and restore the prior delegationMode value (delete the key when previously absent). Do not replace the whole workspace or config. No runtime rebuild is required.

Live verification should compare the same single-tool, independent parallel, dependent write/read-back, and conversation tasks before/after. Inspect native child records, tool receipts, parent completion, and actual file state; an empty initial CLI result after yield is not the final asynchronous parent answer.
