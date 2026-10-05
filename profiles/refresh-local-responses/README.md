# Local stateless Responses migration: Stage1 source handoff

Status: request-local fallback complete and component-tested; ready for parent
integration. Not built, committed, deployed, or live-inference-tested by this worker.
The parent now owns stateless encrypted-state shaping under packages/ai.

Owner: Grond. Checkout: /backup/finnclaw_workspace/openclaw-refresh/audit-20260919,
branch codex/frozen-audit-20260919, starting HEAD
627c549653920abe9fa70f140429846ac88d2aad. Access only through the maintained
finn-node.ps1 -Node grond connector. Windows remains remote control only.

## Source behavior

incomplete-turn-recovery.ts preserves the existing Chat fallback. For an
openai-responses model explicitly opted in with model-level
chat_template_kwargs.enable_thinking true (or its camel-case alias), only retry
count DEFAULT_REASONING_ONLY_RETRY_LIMIT (2) gets reasoningEffort none.
The Chat flag is an opt-in marker, not a Responses payload control.
Earlier attempts and other APIs retain their original request params.

extra-params.ts forwards that request-local disabling control, or an explicit
reasoning off override, as native reasoningEffort none / reasoning off.
It applies only to reasoning-enabled openai-responses models declaring supported
none and not disabling supportsReasoningEffort. The override beats the Agent's
ordinary thinking level, but no configured defaults or input objects are mutated.
These controls stay out of the prepared extra-parameter cache. Sampling, token,
schema, headers and other existing request policy remain intact.

The actual custom-route payload policy requires declared none support.
Without it, moira/brain explicit off is omitted. No global proxy policy was changed.
No provider IDs, model placement, route, or Signal state changed.

Worker-owned changed files:

- src/agents/embedded-agent-runner/extra-params.ts
- src/agents/embedded-agent-runner/extra-params.sampling.test.ts
- src/agents/embedded-agent-runner/run/incomplete-turn-recovery.ts
- src/agents/embedded-agent-runner/run/incomplete-turn-recovery.test.ts
- profiles/refresh-local-responses/README.md
- profiles/refresh-local-responses/config.fragment.json

The four tracked fallback files have 487 insertions and 6 deletions against the
starting HEAD. Exact diff was returned from Grond in the handoff tool output.

## Profile fragment

config.fragment.json is an illustrative ID-targeted edit of existing config,
not a standalone configuration or an array-replacement merge. The parent owns
production/Alistar migration. Preserve URL, auth/TLS, context/max-token/cost
fields, agent IDs, routes, Signal and unrelated settings. This fragment uses
Alistar's finn-coordinator prefix; production keeps remote-llm.

The model declares supportsStore false and disabled reasoning support including
none. Its route params retain the explicit model-level recovery opt-in and SSE.
No global thinking-off setting is added. Low/medium/high retain the existing
generic effort vocabulary; parent live checks establish coordinator acceptance.

## Verification

Public router inside Grond openclaw-refresh-dev, UID1009:1010,
working directory /workspace/audit-20260919:

node --import ./scripts/tsx.mjs scripts/test-projects.mts
src/agents/embedded-agent-runner/extra-params.sampling.test.ts
src/agents/embedded-agent-runner/run/incomplete-turn-recovery.test.ts
src/agents/openai-thinking-contract.test.ts --reporter=dot

Prior formatted fallback run on 2026-10-04 UTC: 129/129 passed, exit0,
two shards /42.27s.

Final public-router run started 2026-10-05 03:46:53 UTC, exit0:

- unit-fast: recovery + thinking contract, 108/108, 13.48s.
- agents-embedded-agent: sampling, 23/23, 24.68s.
- Fallback/contract total: 131/131.
- The already-started pre-ownership-split run additionally passed 24/24 in the
  payload-policy unit, instructions integration and native continuation integration
  files, 2.93s. Full invocation: 155/155, three shards /45.95s.
  These package files are now parent-owned; the result describes that snapshot.

The final invocation used the same public router with the three fallback paths
above plus:
packages/ai/src/transports/openai-responses-payload-policy.test.ts
packages/ai/src/transports/openai-responses-payload-policy.instructions.integration.test.ts
packages/ai/src/transports/openai-responses-client.continuation.integration.test.ts

Formatter succeeded; git diff --check passed. No full build or full typecheck was
run by this worker. Parent builds and validates the exact integrated commit.

Real Agent, managed transport, SDK and loopback HTTP tests prove native none on
only retry2, enabled controls on retry0/1/3, explicit native off, preservation of
temperature/max tokens/structured schema, unchanged inputs and incompatible
provider behavior. Focused wrapper tests prove API/capability gates, retained
headers/token controls, and no cache leakage. These are component/controlled HTTP
cases, not actual coordinator model conversations or production deployment.

History retained: original baseline85/85; diagnostic run29/32 (three incorrect
encrypted-include assumptions), corrected diagnostic92/92. First implementation
run105/106 (one test incorrectly expected enabled reasoning despite an explicit
supportsReasoningEffort false); corrected expectation and final129/129. A formatter
invocation used an absent alternate path and exited before tests; the established
node_modules/.bin/oxfmt succeeded. No failed attempt is claimed green.

## Live evidence and remaining limitation

Parent-reported Alistar declaration check: exact ALISTAR_NATIVE_NONE_42 passed,
run4ff8aae6-7c45-4904-8c7a-6be66693201f,
sessiona2cf530f-5cde-492f-9735-eafa2dad9dbf, reasoningTokens0.
This validates the config capability declaration, not this unbuilt fallback source.

Parent canonical SQLite proves one earlier exec call with matching successful
toolResult text42/exitCode0/isErrorfalse, followed by reasoning-only and visible
final output. Receipt successfulToolNames/replayInvalid projection remains outside
Stage1 scope.

Parent confirmed enabled-low failed before tokens with canonical422, session
ad1ebcc1-4d3e-4d34-aebd-38e850c91e6b. Same-coordinator validation rejects the
reasoning.encrypted_content include with low/summary auto/store false.

Before the subsequent ownership split, this worker had applied a bounded patch to
packages/ai/src/transports/openai-responses-payload-policy.ts and its .test.ts.
Those two pending files were immediately transferred to the parent, with no further
worker package edits. Existing config types and request-builder owner need no new
changes: the policy already runs after native reasoning/include construction.
The pending patch keys encryption omission to explicit compat.supportsStore false,
not ordinary payload store false, and retains visible reasoning. Parent may retain
or replace it. This handoff does not claim the parent's final implementation tested.

The worker's controlled wire cases now additionally assert enabled-low summary auto,
no encrypted include/state, and preserved visible reasoning/tool-call/result replay.
They exercise serialization, not tool execution or live coordinator acceptance.
No tracing was activated. Receipt projection repair remains outside this scope.

## Specification traceability

Central authority: Grond /backup/finnclaw_workspace/finn-specifications,
reviewed commit d8a0a230a468291f4bdf26071bbde92889bdf70c.
BASE-001 r1 F05/F07; FEAT-004 r1 F01/F04/F05;
FEAT-005 r1 F02/F04; FEAT-008 r1 F02/F04/F05.
Draft specs retain explicit binding user constraints; this bounded source evidence
does not certify entire features complete. Normative specs remain central.

Keep these uncommitted changes for parent integration, exact-committed-tree Stage1
build, and Stage2 reconciliation. No push, deployment, coordinator/model mutation,
production/Alistar mutation, global tracing, or delegation occurred here.
