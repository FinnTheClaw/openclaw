/**
 * Post-spawn guidance notes.
 *
 * Returns push-based completion guidance for run spawns and thread-binding guidance for session spawns.
 */
import { isCronSessionKey } from "../routing/session-key.js";

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Track expected child session keys. Continue spawning every worker explicitly requested by the user before yielding or finalizing. Continue any independent work. If the requested result depends on child output, call sessions_yield when available and wait for completion events for ALL required children, then synthesize one user-visible result with outcomes, verification, and remaining blockers. A progress-only update is not the requested final result. Never emit NO_REPLY on the original direct user turn, immediately after spawn acceptance, while requested children remain unspawned, or while required work is unfinished. NO_REPLY is reserved only for a later completion-event turn after a visible final answer was already delivered.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

/** Resolve the post-spawn note, suppressing polling guidance for cron sessions. */
export function resolveSubagentSpawnAcceptedNote(params: {
  spawnMode: "run" | "session";
  agentSessionKey?: string;
}): string | undefined {
  if (params.spawnMode === "session") {
    return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  }
  return isCronSessionKey(params.agentSessionKey) ? undefined : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}
