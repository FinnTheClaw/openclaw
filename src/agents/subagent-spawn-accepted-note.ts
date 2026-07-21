/**
 * Post-spawn guidance notes.
 *
 * Returns push-based completion guidance for run spawns and thread-binding guidance for session spawns.
 */
import { isCronSessionKey } from "../routing/session-key.js";

const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Track expected child session keys. Continue any independent work. If your requested result depends on child output, use sessions_yield when available and wait for runtime completion events to arrive as user messages; deliver the requested final result only after completion events for ALL required children arrive. A progress or waiting update is not the requested final result. Reply ONLY with NO_REPLY after a child completion event when the requested final result was already delivered before that event.";
const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
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
