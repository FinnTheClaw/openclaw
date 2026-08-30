import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { DurableMemoryEmbedding } from "./memory-embedding.js";

export class MemorySensitiveContentError extends Error {
  readonly code = "memory_sensitive_content";

  constructor() {
    super("memory content was rejected because it contains secret-like material");
    this.name = "MemorySensitiveContentError";
  }
}

export function assertMemoryContentSafe(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    throw new Error("memory content must not be empty");
  }
  const redacted = redactSensitiveText(normalized, { mode: "tools" });
  if (redacted !== normalized) {
    throw new MemorySensitiveContentError();
  }
  return normalized;
}

/** Defense in depth: no caller can accidentally bypass the storage guard and
 * send a registered or pattern-matched secret to an embedding provider. */
export function guardMemoryEmbeddingProvider(
  embedding: DurableMemoryEmbedding,
): DurableMemoryEmbedding {
  return {
    embed: async (text, options) => embedding.embed(assertMemoryContentSafe(text), options),
    ...(embedding.embedBatch
      ? {
          embedBatch: async (texts: string[], options?: { timeoutMs?: number }) =>
            embedding.embedBatch!(texts.map(assertMemoryContentSafe), options),
        }
      : {}),
  };
}
