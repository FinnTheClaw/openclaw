// Copies safe transcript tails across session lifecycle rotations.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../../logging/redact.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

/** Tail kept so DM continuity survives silent session rotations. */
export const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: Record<string, unknown> & { role?: unknown; content?: unknown };
};
type KeptRecord = { role: "user" | "assistant"; record: SessionRecord };

const HIDDEN_REPLAY_BLOCK_TYPES = new Set([
  "analysis",
  "reasoning",
  "reasoning_text",
  "redacted_thinking",
  "thinking",
]);
const HIDDEN_REPLAY_FIELDS = [
  "thinking",
  "reasoning",
  "reasoning_content",
  "reasoning_text",
  "reasoning_details",
  "thinkingSignature",
  "openclawReasoningReplay",
] as const;

function stripHiddenReplayReasoning(record: SessionRecord): SessionRecord {
  const sanitized = redactSecrets(record);
  const message = sanitized.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return sanitized;
  }
  const visibleMessage = { ...message };
  for (const field of HIDDEN_REPLAY_FIELDS) {
    delete visibleMessage[field];
  }
  if (Array.isArray(visibleMessage.content)) {
    visibleMessage.content = visibleMessage.content.flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return [block];
      }
      const visibleBlock = { ...(block as Record<string, unknown>) };
      const type = typeof visibleBlock.type === "string" ? visibleBlock.type : "";
      if (HIDDEN_REPLAY_BLOCK_TYPES.has(type)) {
        return [];
      }
      for (const field of HIDDEN_REPLAY_FIELDS) {
        delete visibleBlock[field];
      }
      return [visibleBlock];
    });
  }
  return { ...sanitized, message: visibleMessage };
}

function isValidReplayTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function replayableRole(record: SessionRecord | null): "user" | "assistant" | undefined {
  if (
    !record ||
    record.type !== "message" ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    !isValidReplayTimestamp(record.timestamp) ||
    !(
      record.parentId === null ||
      record.parentId === undefined ||
      typeof record.parentId === "string"
    )
  ) {
    return undefined;
  }
  const role = record.message?.role;
  return role === "user" || role === "assistant" ? role : undefined;
}

/**
 * Copy the tail of user/assistant JSONL records from a prior transcript into a
 * freshly-rotated one. Tool, system, and compaction records are skipped so
 * replay cannot reshape tool/role ordering, and the tail is aligned and
 * coalesced into alternating user/assistant turns so role-ordering resets
 * cannot immediately recur. Uses async I/O so long transcripts do not block
 * the event loop. Returns 0 on any error.
 */
export async function replayRecentUserAssistantMessages(params: {
  sourceTranscript?: string;
  targetTranscript: string;
  newSessionId: string;
  maxMessages?: number;
}): Promise<number> {
  const max = Math.max(0, params.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  const src = params.sourceTranscript;
  if (max === 0 || !src || !fs.existsSync(src)) {
    return 0;
  }
  try {
    const kept: KeptRecord[] = [];
    for (const line of (await fsp.readFile(src, "utf-8")).split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as SessionRecord | null;
        const role = replayableRole(record);
        if (role && record) {
          kept.push({ role, record });
        }
      } catch {
        // Skip malformed lines.
      }
    }
    if (kept.length === 0) {
      return 0;
    }
    let startIdx = Math.max(0, kept.length - max);
    while (startIdx < kept.length && kept[startIdx].role === "assistant") {
      startIdx += 1;
    }
    if (startIdx === kept.length) {
      // Retained window is assistant-only; replaying would re-create the same
      // role-ordering hazard this reset path is recovering from.
      return 0;
    }
    // Replay is a new persistence boundary: never copy prior JSONL bytes. Rebuild
    // each accepted record through mandatory secret and hidden-reasoning removal.
    const tail = coalesceAlternatingReplayTail(kept.slice(startIdx)).map((entry) =>
      JSON.stringify(stripHiddenReplayReasoning(entry.record)),
    );
    if (!fs.existsSync(params.targetTranscript)) {
      await fsp.mkdir(path.dirname(params.targetTranscript), { recursive: true });
      const header = JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.newSessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      });
      await fsp.writeFile(params.targetTranscript, `${header}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    await fsp.appendFile(params.targetTranscript, `${tail.join("\n")}\n`, "utf-8");
    return tail.length;
  } catch {
    return 0;
  }
}

// Keep the newest record from each same-role run while ensuring strict provider alternation.
function coalesceAlternatingReplayTail(entries: KeptRecord[]): KeptRecord[] {
  const tail: KeptRecord[] = [];
  for (const entry of entries) {
    const lastIdx = tail.length - 1;
    if (lastIdx >= 0 && tail[lastIdx]?.role === entry.role) {
      tail[lastIdx] = entry;
      continue;
    }
    tail.push(entry);
  }
  return tail;
}
