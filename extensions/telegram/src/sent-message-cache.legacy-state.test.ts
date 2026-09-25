import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listTelegramLegacySentMessageCacheEntries } from "./sent-message-cache.legacy-state.js";

describe("F12 legacy Telegram cache import", () => {
  const cases = [
    ["F12-01 JSON null", () => "null", 0],
    ["F12-02 null chat", () => JSON.stringify({ chat: null }), 0],
    ["F12-03 scalar root", () => "true", 0],
    ["F12-04 array root", () => "[]", 0],
    ["F12-05 torn JSON", () => "{", 0],
    ["F12-06 valid fresh entry", () => JSON.stringify({ chat: { message: Date.now() } }), 1],
    [
      "F12-07 expired entry",
      () => JSON.stringify({ chat: { message: Date.now() - 90_000_000 } }),
      0,
    ],
    ["F12-08 scalar chat", () => JSON.stringify({ chat: "bad" }), 0],
    [
      "F12-09 retain healthy sibling",
      () => JSON.stringify({ bad: null, good: { message: Date.now() } }),
      1,
    ],
    ["F12-10 missing sidecar", () => undefined, 0],
  ] as const;

  it.each(cases)("%s", (_id, contents, expected) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f12-cache-"));
    try {
      const persistedPath = path.join(dir, "legacy.json");
      const text = contents();
      if (text !== undefined) {
        fs.writeFileSync(persistedPath, text);
      }
      const entries = listTelegramLegacySentMessageCacheEntries({
        persistedPath,
        targetStorePath: path.join(dir, "sessions.json"),
      });
      expect(entries).toHaveLength(expected);
      if (expected > 0) {
        expect(entries[0].value.messageId).toBe("message");
        expect(entries[0].value.chatId).toBe(_id.startsWith("F12-09") ? "good" : "chat");
        expect(entries[0].ttlMs).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
