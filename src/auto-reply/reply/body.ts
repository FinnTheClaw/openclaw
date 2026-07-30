// Builds message body text from session state and reply metadata.
import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { setAbortMemory } from "./abort-primitives.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

const sessionAccessorRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);

function loadSessionAccessorRuntime() {
  return sessionAccessorRuntimeLoader.load();
}

/** Applies one-shot session hints to the agent-visible body and clears consumed flags. */
export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  previousRunStatus?: SessionEntry["status"];
  previousRunWasOrphaned?: boolean;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
}): Promise<string> {
  let prefixedBodyBase = params.baseBody;
  const previousRunHint = params.abortedLastRun
    ? "The previous run was explicitly stopped and is closed. Treat the current user message as a fresh authoritative request. Do not resume prior work unless the current message explicitly asks you to continue it."
    : params.previousRunWasOrphaned
      ? "The previous run was left marked running without an active owner and is closed. Treat the current user message as a fresh authoritative request. Do not resume prior work unless the current message explicitly asks you to continue it."
      : params.previousRunStatus === "failed" ||
          params.previousRunStatus === "timeout" ||
          params.previousRunStatus === "killed"
        ? "The previous run ended without a valid final answer and is closed. Treat the current user message as a fresh authoritative request. Do not resume prior work unless the current message explicitly asks you to continue it."
        : "";
  if (previousRunHint) {
    prefixedBodyBase = `${previousRunHint}\n\n${prefixedBodyBase}`;
    // The durable abort flag is one-shot; clear it once its closure hint is added.
    const sessionEntry = params.sessionEntryHandle?.getCurrent() ?? params.sessionEntry;
    if (sessionEntry && params.sessionEntryHandle && params.sessionKey) {
      const updatedAt = Date.now();
      params.sessionEntryHandle.patchCurrent({
        abortedLastRun: false,
        updatedAt,
      });
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        const { patchSessionEntry } = await loadSessionAccessorRuntime();
        await patchSessionEntry(
          {
            storePath: params.storePath,
            sessionKey,
          },
          () => ({
            abortedLastRun: false,
            updatedAt,
          }),
          { fallbackEntry: params.sessionEntryHandle.getCurrent() ?? sessionEntry },
        );
      }
    } else if (sessionEntry && params.sessionStore && params.sessionKey) {
      const updatedAt = Date.now();
      sessionEntry.abortedLastRun = false;
      sessionEntry.updatedAt = updatedAt;
      params.sessionStore[params.sessionKey] = sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        const { patchSessionEntry } = await loadSessionAccessorRuntime();
        await patchSessionEntry(
          {
            storePath: params.storePath,
            sessionKey,
          },
          () => ({
            abortedLastRun: false,
            updatedAt,
          }),
          { fallbackEntry: sessionEntry },
        );
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  return prefixedBodyBase;
}
