import { registerSecretValueForRedaction } from "openclaw/plugin-sdk/logging-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMemoryContentSafe,
  guardMemoryEmbeddingProvider,
  MemorySensitiveContentError,
} from "./memory-content-guard.js";

describe("memory content guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a fake registered canary without returning it in the error", () => {
    const canary = "fake-memory-canary-do-not-embed-20260810";
    registerSecretValueForRedaction(canary);
    let captured: unknown;
    try {
      assertMemoryContentSafe(`remember ${canary}`);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MemorySensitiveContentError);
    expect(String(captured)).not.toContain(canary);
  });

  it("blocks both single and batch embedding before the provider sees a canary", async () => {
    const canary = "fake-batch-canary-do-not-embed-20260810";
    registerSecretValueForRedaction(canary);
    const embed = vi.fn(async () => [1, 0]);
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const guarded = guardMemoryEmbeddingProvider({ embed, embedBatch });

    await expect(guarded.embed(`secret ${canary}`)).rejects.toBeInstanceOf(
      MemorySensitiveContentError,
    );
    await expect(guarded.embedBatch?.(["safe fact", `secret ${canary}`])).rejects.toBeInstanceOf(
      MemorySensitiveContentError,
    );
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });
});
