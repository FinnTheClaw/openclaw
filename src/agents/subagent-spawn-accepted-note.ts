/**
 * Post-spawn guidance notes.
 *
 * Returns push-based completion guidance for run spawns and thread-binding guidance for session spawns.
 */
import { isCronSessionKey } from "../routing/session-key.js";

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Track expected child session keys. Continue spawning every worker explicitly requested by the user before yielding or finalizing. Continue any independent work. If your final answer depends on child output, wait for runtime completion events to arrive as user messages and only answer after completion events for ALL required children arrive. Never emit NO_REPLY on the original direct user turn, immediately after spawn acceptance, while requested children remain unspawned, or while required work is unfinished. NO_REPLY is reserved only for a later completion-event turn after a visible final answer was already delivered.";
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
