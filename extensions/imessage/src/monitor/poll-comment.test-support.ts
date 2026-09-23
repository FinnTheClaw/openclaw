// These cases exercise the diagnostic poll-reply heuristic. A near-simultaneous
// same-sender reply is ambiguous and must be delivered by the monitor.
import { describe, expect, it } from "vitest";
import { createPollCommentFolder } from "./poll-comment.js";

const POLL_GUID = "75A8F623-947D-4611-A23D-4DDD6D17BC0F";
const T0 = 1_000_000; // arbitrary base timestamp (ms)

describe("createPollCommentFolder", () => {
  it("flags a caption-shaped reply as ambiguous, without authorizing a drop", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    // Caption and genuine quick reply share this shape.
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 500, "+15551110000")).toBe(true);
  });

  it("does NOT flag a deliberate later inline reply to the poll", () => {
    const folder = createPollCommentFolder({ windowMs: 15_000 });
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    // A real "I can't make it" reply a minute later must be delivered.
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 60_000, "+15551110000")).toBe(false);
  });

  it("does NOT flag an in-window reply from a different sender (group member)", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 500, "+15559998888")).toBe(false);
  });

  it("does NOT flag when the reply sender is known but the poll sender is unknown", () => {
    // Fail closed: an unknown-sender poll row must not turn a real in-window
    // reply from an identified participant into a dropped message. This flag
    // runs before the normal missing-sender/allowlist gate.
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, undefined);
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 500, "+15551110000")).toBe(false);
  });

  it("does NOT flag when the reply sender is unknown", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 500, undefined)).toBe(false);
  });

  it("does not flag a reply to an unrelated message", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply("SOME-OTHER-GUID", T0, "+15551110000")).toBe(false);
  });

  it("keeps part-prefixed and raw GUIDs distinct", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(`p:0/${POLL_GUID}`, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0 + 500, "+15551110000")).toBe(false);
  });

  it("does not flag a non-reply or a reply with no usable timestamp", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply(null, T0)).toBe(false);
    expect(folder.isAmbiguousPollReply("", T0)).toBe(false);
    expect(folder.isAmbiguousPollReply(POLL_GUID, Number.NaN)).toBe(false);
  });

  it("does not track a poll without a usable timestamp or guid", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(POLL_GUID, Number.NaN, "+15551110000");
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0)).toBe(false);
    folder.rememberPoll(null, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply("", T0)).toBe(false);
  });

  it("does not flag before the poll has been seen (ordering safety)", () => {
    const folder = createPollCommentFolder();
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0, "+15551110000")).toBe(false);
    folder.rememberPoll(POLL_GUID, T0, "+15551110000");
    expect(folder.isAmbiguousPollReply(POLL_GUID, T0, "+15551110000")).toBe(true);
  });
});
