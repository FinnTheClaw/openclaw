# Refresh Directed Continuation

Optional plugin activation uses the existing plugins enable/disable mechanism.
There are no plugin configuration options. This plugin is independent of
refresh-memory-receipts; it neither supplies nor replaces readback receipts.

## Restricted coverage

The intent signal accepts single-line English imperatives beginning with
"Remember: keep/use/include/avoid/prefer", "Remember [that] I prefer/my preference",
or "Save/update/remove/delete my/the ... preference". An optional leading "Please"
is accepted. Questions, quoted commands, examples, explicit negation and common
tentative language pass unchanged. Other intents and languages are unsupported
and pass unchanged. The lexical signal identifies requests only; it never
establishes persistence, correctness, missing memory, or task success.

For covered requests, concise prompt guidance asks the actor to inspect existing
state, preserve satisfied parts without rewriting, and perform only the actual
missing change. A nonempty final answer with **no observed tool callback** gets
at most one evidence-directed native revision. Any observed tool call suppresses
that revision, including reads, failed calls, and unrelated tools. This is
deliberately not a general completion checker.

The revision accurately says that no tool operation was observed; it does not
claim the requested memory is absent. Startup context may already establish it.
The actor must inspect available evidence, avoid duplicate effects, and report
a no-op or unresolved limitation accurately. Guidance alone cannot guarantee the
actor follows it.

## Native lifecycle

Only existing public plugin hooks are used. State is keyed by runId, never by
session identity, and is removed at agent_end. Repeated before_prompt_build calls
for native finalization revisions retain original intent and tool observations;
native agent_end is suppressed between those revisions. Missing runId is
unsupported and passes unchanged. Native hook eligibility owns cancellation,
incomplete/error output, deterministic effects, and empty-answer recovery.
No new runtime budget, checker model, transport, answer replacement, tool gate,
memory database, or persistent plugin state is introduced.

Focused tests exercise public-hook behavior, intent controls, no-op guidance,
tool observations, repeated prompt builds, cleanup, and run isolation. They are
not live model evidence; paired native replay is required to assess actual
outcomes and extra inference cost.
