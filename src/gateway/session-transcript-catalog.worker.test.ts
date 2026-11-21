import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptMessageEventPage } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as catalog from "./session-transcript-catalog.js";

it("reads catalog titles and cursor pages in workers and observes later transcript writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionId: "catalog-worker",
      sessionKey: "agent:main:catalog-worker",
      storePath: state.statePath("catalog.sqlite"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    await replaceTranscriptEvents(target, [
      { type: "session", version: 3, id: target.sessionId },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Plan the migration" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "question",
        message: { role: "assistant", content: "Start with the history reader" },
      },
    ]);
    await waitForSessionTranscriptProjection(target);
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const reads: string[] = [];
    const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(read, receiver: StatementSync, args) {
            if (
              /\b(?:transcript_events|session_transcript_active_events|transcript_event_identities)\b/iu.test(
                receiver.sourceSQL,
              )
            ) {
              reads.push(receiver.sourceSQL);
            }
            return Reflect.apply(read, receiver, args);
          },
        }),
      );
    });
    const params = { ...target, limit: 1, sourceDomain: "catalog-test", pluginId: "session-share" };
    const historyReads = vi.spyOn(historyWorker, "readSessionHistoryPageInWorker");
    try {
      const first = await catalog.readSessionTranscriptCatalogPage(params);
      expect(first.items.map((item) => item.text)).toEqual(["Start with the history reader"]);
      expect(first.nextCursor).toBeDefined();
      expect(historyReads).toHaveBeenCalledTimes(1);
      expect(reads).toEqual([]);
      expect(await catalog.readSessionTranscriptCatalogTitleAsync({ ...target, entry })).toBe(
        "Plan the migration",
      );
      expect(reads).toEqual([]);

      await appendTranscriptMessage(target, {
        eventId: "later-answer",
        parentId: "answer",
        message: { role: "assistant", content: "The worker now owns the read" },
      });
      await waitForSessionTranscriptProjection(target);
      reads.length = 0;
      const resumed = await catalog.readSessionTranscriptCatalogPage({
        ...params,
        cursor: first.nextCursor,
      });
      expect(resumed.items.map((item) => item.text)).toEqual(["Plan the migration"]);
      historyReads.mockClear();
      const latest = await catalog.readSessionTranscriptCatalogPage(params);
      expect(latest.items.map((item) => item.text)).toEqual(["The worker now owns the read"]);
      expect(historyReads).toHaveBeenCalledTimes(1);
      expect(reads).toEqual([]);
    } finally {
      historyReads.mockRestore();
      observers.forEach((observer) => observer.mockRestore());
    }
  });
});

it("does not duplicate catalog items when a transcript append shifts an internal page", async () => {
  const target = {
    agentId: "main",
    sessionId: "catalog-append",
    sessionKey: "agent:main:catalog-append",
    storePath: "/tmp/synthetic-catalog-append.sqlite",
  };
  using entryRead = vi
    .spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker")
    .mockImplementation(async (_scope, assertCurrent, consume) =>
      consume(
        { ok: true, value: { sessionId: target.sessionId, updatedAt: 1 } },
        { kind: "file", assertCurrent },
      ),
    );
  const row = (seq: number, text: string, visible = true) => ({
    seq,
    eventSeq: seq,
    event: {
      type: "message",
      id: `row-${seq}`,
      message: visible
        ? { role: "user", content: text }
        : { role: "assistant", content: text, display: false },
    },
  });
  const boundary = row(4, "Boundary item");
  const first: SessionTranscriptMessageEventPage = {
    displaySource: "synthetic-display-source",
    activeLeafEntryId: "row-7",
    totalMessages: 7,
    events: [boundary, row(5, "Hidden", false), row(6, "Hidden", false), row(7, "Hidden", false)],
  };
  // Row 8 appends to the same session without replacing its generation. The next
  // offset was computed from seven rows, so the eight-row source includes row 4 again.
  const second: SessionTranscriptMessageEventPage = {
    displaySource: first.displaySource,
    activeLeafEntryId: "row-8",
    totalMessages: 8,
    events: [row(2, "Earlier item"), row(3, "Previous item"), boundary],
  };
  using historyReads = vi
    .spyOn(historyWorker, "readSessionHistoryPageInWorker")
    .mockRejectedValue(new Error("Unexpected additional history read"))
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const result = await catalog
    .readSessionTranscriptCatalogPage({
      ...target,
      limit: 3,
      sourceDomain: "catalog-test",
      pluginId: "session-share",
    })
    .then(
      ({ items }) => ({ texts: items.map((item) => item.text) }),
      (error: unknown) => ({ error }),
    );
  expect(entryRead).toHaveBeenCalledTimes(1);
  expect(historyReads).toHaveBeenCalledTimes(2);
  expect(result).toEqual({
    error: expect.objectContaining({
      message: "Session transcript changed during this read; retry the page.",
    }),
  });
});
