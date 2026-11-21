import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  applyAbortCutoffToSessionEntry,
  hasAbortCutoff,
  readAbortCutoffFromSessionEntry,
  type AbortCutoff,
} from "./abort-cutoff.js";

/** Clears only the observed abort cutoff in memory and persisted session storage. */
export async function clearAbortCutoffInSessionRuntime(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  observedCutoff?: AbortCutoff;
  observedSessionId?: string;
}): Promise<boolean> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
    return false;
  }
  const observedCutoff = params.observedCutoff ?? readAbortCutoffFromSessionEntry(sessionEntry);
  const observedSessionId = params.observedSessionId ?? sessionEntry.sessionId;
  if (!observedCutoff) {
    return false;
  }
  const matchesObserved = (entry: SessionEntry | undefined): boolean => {
    const cutoff = readAbortCutoffFromSessionEntry(entry);
    return (
      entry?.sessionId === observedSessionId &&
      cutoff?.messageSid === observedCutoff.messageSid &&
      cutoff?.timestamp === observedCutoff.timestamp
    );
  };
  if (
    !matchesObserved(sessionEntry) ||
    !matchesObserved(sessionStore[sessionKey] ?? sessionEntry)
  ) {
    return false;
  }

  const updatedAt = Date.now();
  if (storePath) {
    let matched = false;
    await patchSessionEntryCore(
      { storePath, sessionKey },
      (current) => {
        if (!matchesObserved(current)) {
          return null;
        }
        matched = true;
        return {
          abortCutoffMessageSid: undefined,
          abortCutoffTimestamp: undefined,
          updatedAt,
        };
      },
      { fallbackEntry: sessionEntry },
    );
    if (!matched) {
      return false;
    }
  }

  if (matchesObserved(sessionEntry) && matchesObserved(sessionStore[sessionKey] ?? sessionEntry)) {
    applyAbortCutoffToSessionEntry(sessionEntry, undefined);
    sessionEntry.updatedAt = updatedAt;
    sessionStore[sessionKey] = sessionEntry;
  }
  return true;
}
