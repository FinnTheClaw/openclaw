import { readEmbeddingVectors } from "./embedding-vectors.js";
// Memory Host SDK module implements embeddings remote fetch behavior.
import { postJson } from "./post-json.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Fetches and validates OpenAI-compatible embedding responses.

/** Narrow unknown JSON payloads to plain objects. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Resolve expected response count from the request body when input is an array. */
function resolveExpectedEmbeddingCount(body: unknown): number | undefined {
  const input = asRecord(body)?.input;
  return Array.isArray(input) ? input.length : undefined;
}

/** POST an embedding request and return validated vectors in request order. */
export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    body: params.body,
    errorPrefix: params.errorPrefix,
    parse: (payload) => {
      return readEmbeddingVectors(
        asRecord(payload)?.data,
        resolveExpectedEmbeddingCount(params.body),
        params.errorPrefix,
      );
    },
  });
}
