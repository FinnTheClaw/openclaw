import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "../llm/types.js";
import { wrapStreamFnTextTransforms } from "./plugin-text-transforms.js";

const model = {
  api: "openai-responses",
  provider: "test",
  id: "test-model",
} as Model<"openai-responses">;
function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}

describe("checkpoint-90 cross-delta replacement", () => {
  it.each([
    { name: "split-after-h", chunks: ["h", "ello"], from: /hello/g, to: "hi", expected: "hi" },
    { name: "split-after-he", chunks: ["he", "llo"], from: /hello/g, to: "hi", expected: "hi" },
    { name: "split-after-hel", chunks: ["hel", "lo"], from: /hello/g, to: "hi", expected: "hi" },
    { name: "split-after-hell", chunks: ["hell", "o"], from: /hello/g, to: "hi", expected: "hi" },
    { name: "whole-match-one-delta", chunks: ["hello"], from: /hello/g, to: "hi", expected: "hi" },
    {
      name: "adjacent-matches",
      chunks: ["hel", "lohe", "llo"],
      from: /hello/g,
      to: "hi",
      expected: "hihi",
    },
    {
      name: "repeated-separated-matches",
      chunks: ["hello ", "hel", "lo"],
      from: /hello/g,
      to: "hi",
      expected: "hi hi",
    },
    {
      name: "unicode-boundary",
      chunks: ["🌱", "hel", "lo"],
      from: /🌱hello/g,
      to: "sprout",
      expected: "sprout",
    },
    {
      name: "tool-event-interleaving",
      chunks: ["hello", "hello"],
      from: /hello/g,
      to: "hi",
      expected: "hihi",
      tool: true,
    },
    {
      name: "final-flush-and-result-equivalence",
      chunks: ["he", "llo"],
      from: /hello/g,
      to: "hi",
      expected: "hi",
      noEnd: true,
    },
  ])("$name", async ({ chunks, from, to, expected, tool, noEnd }) => {
    const raw = chunks.join("");
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const base: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        void (async () => {
          let partial = "";
          for (const [index, chunk] of chunks.entries()) {
            partial += chunk;
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: chunk,
              partial: message(partial),
            });
            if (tool && index === 0) {
              stream.push({
                type: "toolcall_delta",
                contentIndex: 1,
                delta: '{"query":"x"}',
                partial: message(partial),
              });
              await toolGate;
            }
          }
          if (!noEnd) {
            stream.push({ type: "text_end", contentIndex: 0, content: raw, partial: message(raw) });
          }
          stream.push({ type: "done", reason: "stop", message: message(raw) });
          stream.end();
        })();
      });
      return stream;
    };
    const wrapped = wrapStreamFnTextTransforms({ streamFn: base, output: [{ from, to }] });
    const stream = await Promise.resolve(wrapped(model, {} as Context, undefined));
    const events: AssistantMessageEvent[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    if (tool) {
      const first = await iterator.next();
      const second = await iterator.next();
      if (first.done || second.done) {
        throw new Error("tool event must be delivered before the producer completes");
      }
      expect(first.value.type).toBe("text_delta");
      expect(second.value.type).toBe("toolcall_delta");
      events.push(first.value, second.value);
      releaseTool();
    }
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push(next.value);
    }
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.delta).join("")).toBe(expected);
    const firstPartial = deltas[0]?.partial?.content[0];
    expect(firstPartial).toMatchObject({ type: "text", text: tool ? "hi" : expected });
    const end = events.find((event) => event.type === "text_end");
    if (!noEnd) {
      expect(end).toMatchObject({ content: expected });
    }
    if (tool) {
      expect(events.findIndex((event) => event.type === "text_delta")).toBeLessThan(
        events.findIndex((event) => event.type === "toolcall_delta"),
      );
    }
    expect((await stream.result()).content).toEqual([{ type: "text", text: expected }]);
  });
});
