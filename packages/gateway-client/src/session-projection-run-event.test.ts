import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjectionRunEvent,
  type SessionProjectionScope,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

describe("session projection Gateway run events", () => {
  it.each([
    { runId: "constructor", seq: undefined, existing: false },
    { runId: "constructor", seq: 3, existing: false },
    { runId: "__proto__", seq: undefined, existing: false },
    { runId: "__proto__", seq: 3, existing: false },
    { runId: "constructor", seq: 3, existing: true },
    { runId: "__proto__", seq: 3, existing: true },
  ])("own run contract: %j", ({ runId, seq, existing }) => {
    const projection = createSessionProjection(scope);
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

  it("reconstructs append-only output without losing rich content or duplicating snapshot text", () => {
    let projection = createSessionProjection(scope);
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
      const transition = reduceSessionProjectionRunEvent(projection, {
        ...event,
        runId: "shared-run",
        state: "delta",
      });
      if (!transition) {
        throw new Error("Expected a chat run projection");
      }
      projection = transition.projection;
      expect(transition.currentRun?.message).toEqual({
        ...snapshot,
        content: [{ type: "text", text: event.text }, canvas],
      });
    }
    expect(snapshot.content[0]).toEqual({ type: "text", text: "hello " });
    const final = { role: "assistant", content: "done!" };
    expect(
      reduceSessionProjectionRunEvent(projection, {
        runId: "shared-run",
        state: "final",
        message: final,
      })?.currentRun?.message,
    ).toBe(final);
  });

  it("does not invent a baseline from an orphan append", () => {
    expect(
      reduceSessionProjectionRunEvent(createSessionProjection(scope), {
        runId: "shared-run",
        state: "delta",
        deltaText: "missing prefix",
      })?.currentRun?.message,
    ).toBeUndefined();
  });

  it.each([
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 11, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 12, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 13, resumes: true },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: undefined, resumes: false },
    { terminalSeq: undefined, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
    { terminalSeq: 10, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: Infinity, resumes: false },
  ])("requires newer run-event order before resuming an error: %j", (scenario) => {
    let projection = createSessionProjection(scope);
    const message = { role: "assistant", content: [], stopReason: "error" };
    for (const event of [
      { state: "delta", seq: 8 },
      { state: "error", seq: scenario.terminalSeq, message },
      { state: "error", seq: scenario.repeatedSeq, message },
    ]) {
      const result = reduceSessionProjectionRunEvent(projection, {
        ...event,
        runId: "shared-run",
        errorMessage: "provider unavailable",
      });
      if (!result) {
        throw new Error("Expected a run projection");
      }
      projection = result.projection;
    }
    const delta = {
      runId: "shared-run",
      state: "delta",
      seq: scenario.deltaSeq,
      message: { role: "assistant", content: "resumed output" },
    };
    const resumed = reduceSessionProjectionRunEvent(projection, delta);
    expect(resumed?.currentRun?.status).toBe(scenario.resumes ? "streaming" : "error");
    if (!scenario.resumes) {
      expect(resumed?.projection).toBe(projection);
      expect(resumed?.currentRun?.message).toBe(message);
      expect(resumed?.currentRun?.errorMessage).toBe("provider unavailable");
    }
  });

  it.each([
    { name: "regular final", event: { state: "final" }, status: "completed" },
    {
      name: "yielded end turn",
      event: { state: "final", yielded: true, stopReason: "end_turn" },
      status: "yielded",
    },
    {
      name: "message-owned error",
      event: {
        state: "final",
        message: { role: "assistant", content: "failure", stopReason: "error" },
      },
      status: "error",
    },
    {
      name: "provider timeout",
      event: { state: "error", errorKind: "timeout" },
      status: "timeout",
    },
    { name: "aborted run", event: { state: "aborted" }, status: "aborted" },
    { name: "live delta", event: { state: "delta" }, status: "streaming" },
  ])("normalizes a $name identically for browser and TUI", ({ event, status }) => {
    const result = reduceSessionProjectionRunEvent(
      createSessionProjection(scope),
      { ...event, runId: "shared-run" },
      scope,
    );
    expect(result?.previousRun).toBeUndefined();
    expect(result?.currentRun?.status).toBe(status);
    expect(result?.projection.runs["shared-run"]?.status).toBe(status);
  });

  it("returns both canonical run projections for a duplicate Gateway terminal", () => {
    const final = {
      runId: "shared-run",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "delivered final" }],
        __openclaw: { id: "final-1", seq: 1 },
      },
    };
    const first = reduceSessionProjectionRunEvent(createSessionProjection(scope), final);
    expect(first).not.toBeNull();
    if (!first) {
      return;
    }
    const repeated = reduceSessionProjectionRunEvent(first.projection, final);
    expect(repeated?.previousRun).toBe(first.currentRun);
    expect(repeated?.projection).toBe(first.projection);
    expect(repeated?.currentRun).toBe(first.currentRun);
  });

  it.each(["status", undefined])("rejects non-run Gateway event state %j", (state) => {
    expect(
      reduceSessionProjectionRunEvent(createSessionProjection(scope), {
        runId: "shared-run",
        state,
      }),
    ).toBeNull();
  });
});
