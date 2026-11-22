import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { hasNonTextEmbeddingParts } from "./embedding-inputs.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import type { EmbeddingProvider } from "./embeddings.types.js";
import type { MemoryChunk } from "./internal.js";

// Enforces provider byte budgets before chunks reach embedding workers.

/**
 * Split text-only chunks to the provider's effective input limit, reserving
 * room for any literal formatting the caller adds before sending each chunk.
 *
 * Structured multimodal chunks are preserved because only the provider can decide how to count
 * non-text parts.
 */
export function enforceEmbeddingMaxInputTokens(
  provider: Pick<EmbeddingProvider, "id" | "maxInputTokens">,
  chunks: MemoryChunk[],
  hardMaxInputTokens?: number,
  textInputOverheadBytes = 0,
): MemoryChunk[] {
  const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
  const maxInputTokens =
    typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
      ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
      : providerMaxInputTokens;
  const maxTextBytes = maxInputTokens - textInputOverheadBytes;
  const out: MemoryChunk[] = [];

  for (const chunk of chunks) {
    if (
      hasNonTextEmbeddingParts(chunk.embeddingInput) ||
      estimateUtf8Bytes(chunk.text) <= maxTextBytes
    ) {
      out.push(chunk);
      continue;
    }

    if (maxTextBytes <= 0) {
      throw new RangeError("Memory embedding document prefix leaves no room for indexed text");
    }
    for (const text of splitTextToUtf8ByteLimit(chunk.text, maxTextBytes)) {
      // A literal prefix must not silently turn an indivisible code point into an oversized input.
      if (textInputOverheadBytes > 0 && estimateUtf8Bytes(text) > maxTextBytes) {
        throw new RangeError(
          "Memory embedding document prefix leaves too little room for indexed text",
        );
      }
      out.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.entryStartLine !== undefined
          ? { entryStartLine: chunk.entryStartLine, entryEndLine: chunk.entryEndLine }
          : {}),
        text,
        hash: sha256Hex(text),
        embeddingInput: { text },
        ...(chunk.provenance ? { provenance: chunk.provenance } : {}),
      });
    }
  }

  return out;
}
