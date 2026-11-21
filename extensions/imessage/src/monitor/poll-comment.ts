// Native poll captions can arrive as inline replies to poll balloons.
// A genuine immediate reply from the same sender has the same GUID, sender,
// and timing shape; this tracker can only flag ambiguity, never prove a
// caption or authorize dropping a message.

import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const COMMENT_WINDOW_MS = 15_000;

type SeenPoll = { atMs: number; sender: string };

export function createPollCommentFolder() {
  const seenPolls = new Map<string, SeenPoll>();

  function prune(referenceMs: number): void {
    for (const [key, seen] of seenPolls) {
      if (referenceMs - seen.atMs > COMMENT_WINDOW_MS) {
        seenPolls.delete(key);
      }
    }
  }

  return {
    // Remember a native poll balloon (its guid + send time + creator) so a
    // caption reply that lands within the window from the same sender can be
    // flagged. `atMs` is the poll's created_at; without a usable timestamp or
    // guid the poll is not tracked (flag stays disabled — messages deliver).
    rememberPoll(guid: string | null | undefined, atMs: number, sender?: string | null): void {
      const key = guid?.trim();
      if (!key || !Number.isFinite(atMs)) {
        return;
      }
      prune(atMs);
      seenPolls.set(key, { atMs, sender: normalizeLowercaseStringOrEmpty(sender) });
    },
    // Flag a possible caption, which could equally be a genuine quick reply.
    // Callers must not suppress delivery based on this heuristic alone.
    isAmbiguousPollReply(
      replyToGuid: string | null | undefined,
      atMs: number,
      sender?: string | null,
    ): boolean {
      const key = replyToGuid?.trim();
      if (!key || !Number.isFinite(atMs)) {
        return false;
      }
      const seen = seenPolls.get(key);
      if (!seen || atMs < seen.atMs || atMs - seen.atMs > COMMENT_WINDOW_MS) {
        return false;
      }
      const replySender = normalizeLowercaseStringOrEmpty(sender);
      // Require known matching senders to limit diagnostic noise. Unknown or
      // mismatched identity is not evidence of a caption either.
      return seen.sender.length > 0 && replySender.length > 0 && seen.sender === replySender;
    },
  };
}
