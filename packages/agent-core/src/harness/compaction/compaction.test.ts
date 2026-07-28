import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { SessionTreeEntry } from "../types.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  findLatestAuthoritativeUserRequest,
  generateSummary,
  prepareCompaction,
} from "./compaction.js";
import { createFileOps } from "./utils.js";

describe("calculateContextTokens", () => {
  it("prefers the final-iteration context snapshot over aggregate billing usage", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: {
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(163_978);
  });

  it("preserves the numeric compatibility fallback when the snapshot is unavailable", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: { state: "unavailable" },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(927_907);
  });

  it("estimates the transcript instead of using aggregate billing when context is unavailable", () => {
    const estimate = estimateContextTokens([
      { role: "user", content: "hello", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ]);

    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
  });

  it("uses the previous exact snapshot and estimates only the unavailable tail", () => {
    const estimate = estimateContextTokens([
      {
        role: "assistant",
        content: [{ type: "text", text: "previous" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 1_000,
          cacheRead: 148_862,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 149_874,
          },
          totalTokens: 149_874,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
      { role: "user", content: "next", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ]);

    expect(estimate.usageTokens).toBe(149_874);
    expect(estimate.tokens).toBeGreaterThan(149_874);
    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.lastUsageIndex).toBe(0);
  });
});

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });
});

describe("split-turn compaction", () => {
  it("serializes history and turn-prefix summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const streamFn = vi.fn<StreamFn>(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      callCount++;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        active--;
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `summary-${callCount}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 5);
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "kept-entry",
        activeUserRequest: "finish the current benchmark without restarting",
        messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.summary).toContain("**Current user-authored request (verbatim):**");
    expect(result.value.summary).toContain("finish the current benchmark");
    expect(result.value.summary).not.toContain("**Active user request (verbatim):**");
  });
});

describe("authoritative compaction request anchor", () => {
  it("ignores newer runtime-generated user-role events", () => {
    const entries = [
      {
        type: "message",
        id: "real-user",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "user",
          content: "Repair module two and finish the benchmark.",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "internal-user",
        parentId: "real-user",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "user",
          content:
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\n" +
            "[Internal task completion event]\nstale subagent result",
          timestamp: 2,
        },
      },
    ] as SessionTreeEntry[];

    expect(findLatestAuthoritativeUserRequest(entries)).toBe(
      "Repair module two and finish the benchmark.",
    );
  });
});

describe("successor compaction boundary progress", () => {
  it("advances beyond the previous retained boundary when the normal keep budget cannot", () => {
    const assistant = (text: string, timestamp: number) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "openai-responses",
      provider: "remote-llm",
      model: "moira/brain",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp,
    });
    const entries = [
      {
        type: "message",
        id: "old-user",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "old request", timestamp: 1 },
      },
      {
        type: "message",
        id: "old-assistant",
        parentId: "old-user",
        timestamp: new Date(2).toISOString(),
        message: assistant("old response", 2),
      },
      {
        type: "message",
        id: "retained-boundary",
        parentId: "old-assistant",
        timestamp: new Date(3).toISOString(),
        message: assistant("retained historical response", 3),
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "retained-boundary",
        timestamp: new Date(4).toISOString(),
        summary: "historical summary",
        firstKeptEntryId: "retained-boundary",
        tokensBefore: 2_000,
      },
      {
        type: "message",
        id: "active-user",
        parentId: "compaction-1",
        timestamp: new Date(5).toISOString(),
        message: {
          role: "user",
          content: "finish the current benchmark and preserve every completed artifact",
          timestamp: 5,
        },
      },
      {
        type: "message",
        id: "active-assistant",
        parentId: "active-user",
        timestamp: new Date(6).toISOString(),
        message: assistant("x".repeat(2_800), 6),
      },
    ] as SessionTreeEntry[];

    const result = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 500,
      keepRecentTokens: 1_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) {
      throw new Error("expected a progressing successor compaction");
    }
    expect(result.value.firstKeptEntryId).not.toBe("retained-boundary");
    expect(result.value.firstKeptEntryId).toBe("active-assistant");
    expect(result.value.isSplitTurn).toBe(true);
    expect(JSON.stringify(result.value.turnPrefixMessages)).toContain(
      "finish the current benchmark",
    );
  });
});
