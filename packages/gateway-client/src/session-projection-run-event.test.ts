import { assert, expect, it } from "vitest";
import {
  reduceSessionProjectionRunEvent,
  reduceSessionProjection as reduce,
  readSessionMessageIdentity,
  readSessionProjectionFinalMessageIdentity,
  type SessionProjectionGatewayRunEvent,
  type SessionProjectionState,
} from "./session-projection.js";
import {
  primaryScope as scope,
  projection,
  projection as createProjection,
  user,
  assistant,
} from "./session-projection.test-support.js";

function runEvent(state: SessionProjectionState, event: SessionProjectionGatewayRunEvent) {
  const transition = reduceSessionProjectionRunEvent(state, { runId: "shared-run", ...event });
  assert(transition);
  return transition;
}

it("clears an existing diagnostic when the terminal owner suppresses its notice", () => {
  const failure = { state: "error", errorMessage: "No answer was returned" };
  const failed = runEvent(projection(), failure);
  const suppressed = runEvent(failed.projection, { ...failure, suppressErrorNotice: true });
  expect(suppressed.currentRun).toMatchObject({
    status: "error",
    suppressErrorNotice: true,
    errorMessage: undefined,
  });
  expect(runEvent(suppressed.projection, failure).currentRun?.errorMessage).toBeUndefined();
});

it("reconstructs append-only output without losing rich content or duplicating snapshot text", () => {
  let state = projection();
  const canvas = { type: "canvas", id: "canvas-1" };
  const metadata = { media: [{ id: "image-1" }] };
  const snapshot = {
    role: "assistant",
    content: [{ type: "text", text: "hello " }, canvas],
    __openclaw: metadata,
  };
  for (const event of [
    { message: snapshot, deltaText: "hello ", text: "hello " },
    { deltaText: " world\n", text: "hello  world\n" },
    { deltaText: "reset", replace: true, text: "reset" },
    { deltaText: "", replace: true, text: "" },
    { deltaText: "done", text: "done" },
  ]) {
    const transition = runEvent(state, { ...event, state: "delta" });
    state = transition.projection;
    expect(transition.currentRun?.message).toEqual({
      ...snapshot,
      content: [{ type: "text", text: event.text }, canvas],
    });
  }
  expect(snapshot.content[0]).toEqual({ type: "text", text: "hello " });
  const final = { role: "assistant", content: "done!" };
  expect(runEvent(state, { state: "final", message: final }).currentRun?.message).toBe(final);
});

it("does not invent a baseline from an orphan append", () => {
  const orphan = runEvent(projection(), { state: "delta", deltaText: "missing prefix" });
  expect(orphan.currentRun?.message).toBeUndefined();
});

it.each([
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 11, resumes: false },
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 13, resumes: true },
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: undefined, resumes: false },
  { terminalSeq: undefined, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
])("requires newer run-event order before resuming an error: %j", (scenario) => {
  let state = projection();
  const message = { role: "assistant", content: [], stopReason: "error" };
  for (const event of [
    { state: "delta", seq: 8 },
    { state: "error", seq: scenario.terminalSeq, message },
    { state: "error", seq: scenario.repeatedSeq, message },
  ]) {
    const result = runEvent(state, {
      ...event,
      errorMessage: "provider unavailable",
    });
    state = result.projection;
  }
  const delta = {
    state: "delta",
    seq: scenario.deltaSeq,
    message: { role: "assistant", content: "resumed output" },
  };
  const resumed = runEvent(state, delta);
  expect(resumed?.currentRun?.status).toBe(scenario.resumes ? "streaming" : "error");
  if (!scenario.resumes) {
    expect(resumed?.projection).toBe(state);
    expect(resumed?.currentRun?.message).toBe(message);
    expect(resumed?.currentRun?.errorMessage).toBe("provider unavailable");
  }
});

it.each([
  ["yielded end turn", { state: "final", yielded: true, stopReason: "end_turn" }, "yielded"],
  [
    "message-owned error",
    {
      state: "final",
      message: { role: "assistant", content: "failure", stopReason: "error" },
    },
    "error",
  ],
  ["provider timeout", { state: "error", errorKind: "timeout" }, "timeout"],
  ["aborted run", { state: "aborted" }, "aborted"],
] as const)("normalizes %s for browser and TUI", (_name, event, status) => {
  const result = reduceSessionProjectionRunEvent(
    projection(),
    { ...event, runId: "shared-run" },
    scope,
  );
  expect(result?.previousRun).toBeUndefined();
  expect(result?.currentRun?.status).toBe(status);
  expect(result?.projection.runs["shared-run"]?.status).toBe(status);
});

it("rejects non-run Gateway event states", () => {
  expect(
    reduceSessionProjectionRunEvent(projection(), {
      runId: "shared-run",
      state: "status",
    }),
  ).toBeNull();
});

it.each([
  { role: "user", rawSeq: 0 },
  { role: "assistant", rawSeq: 9 },
] as const)("keeps a canonical $role row stable through CLI enrichment", ({ role, rawSeq }) => {
  const metadata = {
    id: "native-row",
    seq: 1,
    transcriptPosition: { source: "canonical-transcript", rawSeq },
  };
  const native = { role, content: "Persisted message", __openclaw: metadata };
  const enriched = {
    ...native,
    __openclaw: {
      ...metadata,
      importedFrom: "claude-cli",
      cliSessionId: "external-session",
      externalId: "provider-row",
    },
  };
  let state = projection([enriched]);
  state = reduce(state, { type: "messagePersisted", message: native });
  state = reduce(state, { type: "transportGap" });
  state = reduce(state, { type: "reconnected" });
  state = reduce(state, { type: "snapshotLoaded", messages: [enriched] });

  expect(state.messages).toEqual([enriched]);
  expect(state.hasTransportGap).toBe(false);
  expect(readSessionProjectionFinalMessageIdentity(enriched)).toBe(
    readSessionProjectionFinalMessageIdentity(native),
  );
});

it.each([
  ["user", "persisted-run", "conflicting-producer-run"],
  ["assistant", "producer-run", "producer-run"],
] as const)(
  "keeps persisted %s identity and producer-owned run precedence",
  (role, runId, envelopeRun) => {
    const id = `${role}-row`;
    const idempotencyKey = `${runId}:${role}`;
    const message = (role === "user" ? user : assistant)("persisted", {
      id,
      idempotencyKey,
      seq: 3,
    });
    expect(
      readSessionMessageIdentity(message, {
        clientRunId: "conflicting-client-run",
        messageId: "envelope-id",
        messageSeq: 99,
        runId: envelopeRun,
      }),
    ).toMatchObject({ id, idempotencyKey, role, runId, sequence: 3 });
  },
);

it("falls back from an unsafe persisted sequence to the envelope", () => {
  expect(
    readSessionMessageIdentity(
      user("unsafe-sequence", { id: "unsafe-sequence", seq: Number.MAX_SAFE_INTEGER + 1 }),
      {
        messageSeq: 5,
      },
    ),
  ).toMatchObject({ id: "unsafe-sequence", role: "user", sequence: 5 });
});

it.each([
  { runId: "constructor", seq: undefined, existing: false },
  { runId: "constructor", seq: 3, existing: false },
  { runId: "__proto__", seq: undefined, existing: false },
  { runId: "__proto__", seq: 3, existing: false },
  { runId: "constructor", seq: 3, existing: true },
  { runId: "__proto__", seq: 3, existing: true },
])("own run contract: %j", ({ runId, seq, existing }) => {
  const projection = createProjection();
  const canvas = { type: "canvas", id: "owned-canvas" };
  const snapshot = {
    role: "assistant",
    content: [{ type: "text", text: "first" }, canvas],
    __openclaw: { media: [{ id: "owned-image" }] },
  };
  const previous = {
    runId,
    status: "streaming" as const,
    seq: 1,
    message: snapshot,
  };
  if (existing) {
    projection.runs = { [runId]: previous };
  }
  const originalRuns = projection.runs;
  const firstEvent = { runId, state: "delta", seq, message: snapshot };
  const first = reduceSessionProjectionRunEvent(projection, firstEvent, scope);
  expect(first).not.toBeNull();
  if (!first) {
    throw new Error("Expected a run projection");
  }
  expect(Object.hasOwn(first.projection.runs, runId)).toBe(true);
  expect(first.previousRun).toBe(existing ? previous : undefined);
  expect(first.currentRun).toMatchObject({ runId, status: "streaming", seq });
  expect(first.currentRun).toBe(first.projection.runs[runId]);
  expect(first.currentRun?.message).toBe(snapshot);
  expect(first.projection).not.toBe(projection);
  expect(projection.runs).toBe(originalRuns);
  expect(Object.hasOwn(projection.runs, runId)).toBe(existing);
  expect(existing ? projection.runs[runId] : undefined).toBe(existing ? previous : undefined);
  expect(previous).toEqual({ runId, status: "streaming", seq: 1, message: snapshot });
  expect(firstEvent).toEqual({ runId, state: "delta", seq, message: snapshot });

  const appended = reduceSessionProjectionRunEvent(
    first.projection,
    {
      runId,
      state: "delta",
      seq: seq === undefined ? undefined : 4,
      deltaText: " next",
    },
    scope,
  );
  expect(appended?.previousRun).toBe(first.currentRun);
  expect(appended?.currentRun).toMatchObject({ runId, status: "streaming" });
  expect(appended?.currentRun?.message).toEqual({
    ...snapshot,
    content: [{ type: "text", text: "first next" }, canvas],
  });
  expect(first.currentRun?.message).toBe(snapshot);
  expect(snapshot.content).toEqual([{ type: "text", text: "first" }, canvas]);
  if (!appended) {
    throw new Error("Expected an appended run projection");
  }

  const final = {
    runId,
    state: "final",
    seq: seq === undefined ? undefined : 5,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      __openclaw: { id: "owned-final", seq: 1 },
    },
  };
  const completed = reduceSessionProjectionRunEvent(appended.projection, final, scope);
  expect(completed?.previousRun).toBe(appended.currentRun);
  expect(completed?.currentRun).toMatchObject({ runId, status: "completed" });
  expect(completed?.currentRun?.message).toBe(final.message);
  expect(Object.hasOwn(completed!.projection.runs, runId)).toBe(true);
  if (!completed) {
    throw new Error("Expected a completed run projection");
  }
  const repeated = reduceSessionProjectionRunEvent(completed.projection, final, scope);
  expect(repeated?.previousRun).toBe(completed.currentRun);
  expect(repeated?.currentRun).toBe(completed.currentRun);
  expect(repeated?.projection).toBe(completed.projection);
  const late = reduceSessionProjectionRunEvent(
    completed.projection,
    {
      runId,
      state: "delta",
      seq: seq === undefined ? undefined : 6,
      message: { role: "assistant", content: "late" },
    },
    scope,
  );
  expect(late?.projection).toBe(completed.projection);
  expect(late?.currentRun).toBe(completed.currentRun);
  expect(final.message.content).toEqual([{ type: "text", text: "done" }]);
});
