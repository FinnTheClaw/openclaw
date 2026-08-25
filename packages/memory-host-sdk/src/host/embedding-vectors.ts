// Vector normalization helpers used before embedding similarity search.

/** Narrow unknown JSON payloads to non-array objects. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate provider embeddings and restore their original request order. */
export function readEmbeddingVectors(
  data: unknown,
  expectedCount: number | undefined,
  errorPrefix: string,
  decodeEmbedding?: (value: unknown) => number[],
): number[][] {
  const malformedResponse = () => new Error(`${errorPrefix}: malformed JSON response`);
  if (!Array.isArray(data) || (expectedCount !== undefined && data.length !== expectedCount)) {
    throw malformedResponse();
  }

  const vectors: number[][] = [];
  let indexed: boolean | undefined;
  for (let position = 0; position < data.length; position += 1) {
    const entry = asRecord(data[position]);
    const usesIndex = entry?.index !== undefined;
    if (!entry || (indexed !== undefined && indexed !== usesIndex)) {
      throw malformedResponse();
    }
    let embedding: unknown = entry.embedding;
    if (decodeEmbedding) {
      try {
        embedding = decodeEmbedding(embedding);
      } catch {
        throw malformedResponse();
      }
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw malformedResponse();
    }
    for (const coordinate of embedding) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        throw malformedResponse();
      }
    }

    indexed = usesIndex;
    const index = usesIndex ? entry.index : position;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= data.length ||
      vectors[index] !== undefined
    ) {
      throw malformedResponse();
    }
    vectors[index] = embedding as number[];
  }
  return vectors;
}

/** Replace invalid coordinates and L2-normalize non-empty vectors. */
export function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}
