import { createServer, type RequestListener } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import { listenLoopback } from "../../../../test/helpers/gateway-integration-fixtures.js";
import { configureAiTransportHost } from "../host.js";
import { collectEventTypes } from "../transports/openai-stream-cases.test-support.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { makeProviderModel } from "./provider-model.test-support.js";

// Stands in for the payload class this path exposes: text the model emitted, which
// reaches the SSE frame as ordinary assistant content.
const SENTINEL = "MODEL_EMITTED_SENTINEL_a1b2c3";

// A truncated frame. repairJson only escapes control characters inside string
// literals, so an unterminated object still reaches JSON.parse as a SyntaxError.
const MALFORMED_FRAME = `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${SENTINEL}"`;

const WELL_FORMED_FRAMES = [
  [
    "message_start",
    '{"type":"message_start","message":{"id":"msg_control","type":"message","role":"assistant",' +
      '"model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,' +
      '"usage":{"input_tokens":3,"output_tokens":1}}}',
  ],
  [
    "content_block_start",
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  ],
  [
    "content_block_delta",
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  ],
  ["content_block_stop", '{"type":"content_block_stop","index":0}'],
  [
    "message_delta",
    '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},' +
      '"usage":{"output_tokens":1}}',
  ],
  ["message_stop", '{"type":"message_stop"}'],
] as const;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(
  baseUrl: string,
  overrides: Partial<Model<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
  return makeProviderModel("anthropic-messages", "anthropic", "claude-sonnet-4-6", {
    name: "Claude Sonnet 4.6",
    baseUrl,
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  });
}

async function withLoopback<T>(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  const baseUrl = await listenLoopback(server);
  try {
    return await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// Real loopback socket speaking Anthropic's event stream. Only the far end of the
// socket is ours; the SDK, its SSE reader, and the provider stream are production code.
async function streamAnthropicSseFrames(
  frames: readonly (readonly [string, string])[],
): Promise<{ stopReason: string; errorMessage?: string }> {
  return withLoopback(
    (request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const [event, data] of frames) {
        response.write(`event: ${event}\ndata: ${data}\n\n`);
      }
      response.end();
      void request.resume();
    },
    async (baseUrl) => {
      const result = await streamAnthropic(makeModel(baseUrl), context, {
        apiKey: "test-api-key",
      }).result();
      return { stopReason: result.stopReason, errorMessage: result.errorMessage };
    },
  );
}

describe("Anthropic malformed SSE frames", () => {
  it.each([
    { label: "valid Windows path with newline", text: "C:\\notes\nnext", wire: "json" },
    { label: "valid Windows path with tab", text: "C:\\notes\tnext", wire: "json" },
    { label: "intentional literal backslash n", text: "C:\\notes\\nnext", wire: "json" },
    { label: "ordinary newline", text: "ordinary\nnext", wire: "json" },
    { label: "repairable invalid escape", text: "C:\\q", wire: "invalid-escape" },
    { label: "sanitized truncated frame", text: SENTINEL, wire: "truncated" },
  ] as const)("L11-F009 preserves authoritative SSE text: $label", async ({ text, wire }) => {
    const validData = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    const data =
      wire === "truncated"
        ? MALFORMED_FRAME
        : wire === "invalid-escape"
          ? validData.replace("\\\\q", "\\q")
          : validData;
    const authoritativeText = wire === "json" ? JSON.parse(data).delta.text : null;
    const frames: readonly (readonly [string, string])[] = [
      ...WELL_FORMED_FRAMES.slice(0, 2),
      ["content_block_delta", data],
      ...WELL_FORMED_FRAMES.slice(3),
    ];
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestUrls.push(input instanceof Request ? input.url : String(input));
      return new Response(
        frames
          .map(([event, frameData]) => "event: " + event + "\ndata: " + frameData + "\n\n")
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const baseUrl = "https://api.anthropic.com";
    const client = new Anthropic({
      apiKey: "test-api-key",
      baseURL: baseUrl,
      maxRetries: 0,
      fetch: fetchMock,
    });
    const stream = streamAnthropic(makeModel(baseUrl), context, {
      apiKey: "test-api-key",
      client,
    });
    const eventTypes: string[] = [];
    const deltas: string[] = [];
    const errorMessages: Array<string | undefined> = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "text_delta") {
        deltas.push(event.delta);
      } else if (event.type === "error") {
        errorMessages.push(event.error.errorMessage);
      }
    }
    const result = await stream.result();
    const observed = {
      authoritativeText,
      requestUrls,
      requests: fetchMock.mock.calls.length,
      eventTypes,
      deltas,
      errorMessages,
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      textBlocks: result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text),
    };
    expect({ requests: observed.requests, urls: observed.requestUrls }).toEqual({
      requests: 1,
      urls: ["https://api.anthropic.com/v1/messages"],
    });
    if (wire === "json") {
      expect(observed.authoritativeText).toBe(text);
    }
    if (wire === "truncated") {
      expect({
        terminal: observed.eventTypes.at(-1),
        deltas: observed.deltas,
        stopReason: observed.stopReason,
        errorMessage: observed.errorMessage,
        errorMessages: observed.errorMessages,
      }).toEqual({
        terminal: "error",
        deltas: [],
        stopReason: "error",
        errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
        errorMessages: [MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE],
      });
      expect(observed.errorMessage).not.toContain(SENTINEL);
      expect(observed.errorMessages.join(" ")).not.toContain(SENTINEL);
    } else {
      expect({
        terminal: observed.eventTypes.at(-1),
        deltas: observed.deltas,
        textBlocks: observed.textBlocks,
        stopReason: observed.stopReason,
        errorMessage: observed.errorMessage,
        errorMessages: observed.errorMessages,
      }).toEqual({
        terminal: "done",
        deltas: [text],
        textBlocks: [text],
        stopReason: "stop",
        errorMessage: undefined,
        errorMessages: [],
      });
    }
  });

  it("reports the shared malformed-fragment error without echoing the frame payload", async () => {
    const result = await streamAnthropicSseFrames([["content_block_delta", MALFORMED_FRAME]]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(result.errorMessage).not.toContain(SENTINEL);
  });

  it("keeps a response alive while Anthropic sends protocol pings", async () => {
    const idleTimeoutMs = 1_000;
    const finalResponseDelayMs = 1_200;
    let pingCount = 0;
    await withLoopback(
      (request, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const writeFrame = ([event, data]: (typeof WELL_FORMED_FRAMES)[number]) => {
          response.write(`event: ${event}\ndata: ${data}\n\n`);
        };
        writeFrame(WELL_FORMED_FRAMES[0]);
        const pingTimer = setInterval(() => {
          pingCount += 1;
          response.write('event: ping\ndata: {"type":"ping"}\n\n');
        }, 20);
        const finalTimer = setTimeout(() => {
          clearInterval(pingTimer);
          for (const frame of WELL_FORMED_FRAMES.slice(1)) {
            writeFrame(frame);
          }
          response.end();
        }, finalResponseDelayMs);
        response.on("close", () => {
          clearInterval(pingTimer);
          clearTimeout(finalTimer);
        });
        void request.resume();
      },
      async (baseUrl) => {
        const onIdleTimeout = vi.fn();
        const stream = (await Promise.resolve(
          streamWithIdleTimeout(streamAnthropic as never, idleTimeoutMs, onIdleTimeout)(
            makeModel(baseUrl),
            context,
            { apiKey: "test-api-key" },
          ),
        )) as ReturnType<typeof streamAnthropic>;
        for await (const event of stream) {
          // The idle watchdog guards consumer waits between provider events.
          void event;
        }
        const result = await stream.result();
        expect(result.stopReason).toBe("stop");
        expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
        expect(onIdleTimeout).not.toHaveBeenCalled();
        expect(pingCount).toBeGreaterThan(0);
        expect(finalResponseDelayMs).toBeGreaterThan(idleTimeoutMs);
      },
    );
  });

  it.each([
    {
      label: "rejects a ping-only first-party stream",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      frames: [["ping", '{"type":"ping"}']] as const,
      stopReason: "error",
    },
    {
      label: "still accepts a ping-only Anthropic-compatible custom endpoint",
      provider: "anthropic",
      baseUrl: "https://proxy.example.com/v1",
      frames: [["ping", '{"type":"ping"}']] as const,
      stopReason: "stop",
    },
    {
      label: "accepts a complete compatible provider stream without message_stop",
      provider: "openrouter",
      baseUrl: "https://proxy.example.com/v1",
      frames: WELL_FORMED_FRAMES.slice(0, -1),
      stopReason: "stop",
    },
  ])("$label", async ({ provider, baseUrl, frames, stopReason }) => {
    const client = new Anthropic({
      apiKey: "test-api-key",
      baseURL: baseUrl,
      fetch: async () =>
        new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const stream = streamAnthropic({ ...makeModel(baseUrl), provider }, context, {
      apiKey: "test-api-key",
      client,
    });
    const eventTypes = await collectEventTypes(stream);
    const result = await stream.result();

    expect(result.stopReason).toBe(stopReason);
    expect(eventTypes.at(-1)).toBe(stopReason === "error" ? "error" : "done");
    expect(result.errorMessage).toBe(
      stopReason === "error" ? "Anthropic stream ended before message_stop" : undefined,
    );
    if (frames.length > 1 && stopReason === "stop") {
      expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
    }
  });
});

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  apiKey?: string;
  resourceKey?: string;
};
afterEach(() => configureAiTransportHost({}));
describe("Anthropic SDK host fetch wiring", () => {
  it("does not send a request when aborted while client preparation is pending", async () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    const controller = new AbortController();
    const stream = streamAnthropic(makeModel("https://example.invalid"), context, {
      apiKey: "synthetic",
      signal: controller.signal,
    });
    controller.abort();
    expect(await collectEventTypes(stream)).toEqual(["error"]);
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("routes every non-Cloudflare client branch through the host fetch", async () => {
    const requests: CapturedRequest[] = [];
    await withLoopback(
      (request, response) => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
          apiKey: request.headers["x-api-key"] as string | undefined,
          resourceKey: request.headers["api-key"] as string | undefined,
        });
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "test rejection" },
          }),
        );
      },
      async (baseUrl) => {
        const hostFetch = vi.fn<typeof fetch>((input, init) => globalThis.fetch(input, init));
        const buildModelFetch = vi.fn(() => hostFetch);
        configureAiTransportHost({ buildModelFetch });
        const cases = [
          {
            model: makeModel(baseUrl, { provider: "github-copilot" }),
            apiKey: "copilot-token",
          },
          {
            model: makeModel(baseUrl, {
              provider: "microsoft-foundry",
              authHeader: true,
              headers: { "api-key": "stale-foundry-key", "x-api-key": "stale-resource-key" },
            }),
            apiKey: "foundry-token",
          },
          {
            model: makeModel(baseUrl),
            apiKey: "sk-ant-oat01-oauth-token", // pragma: allowlist secret
          },
          {
            model: makeModel(baseUrl, {
              provider: "microsoft-foundry",
              headers: { "api-key": "foundry-resource-key" },
            }),
            apiKey: "foundry-resource-key",
          },
          {
            model: makeModel(baseUrl, { provider: "kimi-coding" }),
            apiKey: "kimi-api-key",
            thinkingEnabled: true,
          },
        ];
        for (const testCase of cases) {
          const result = await streamAnthropic(testCase.model, context, {
            apiKey: testCase.apiKey,
            thinkingEnabled: testCase.thinkingEnabled,
          }).result();
          expect(result.stopReason).toBe("error");
        }
        expect(hostFetch).toHaveBeenCalledTimes(cases.length);
        for (const request of requests) {
          expect([request.method, request.path]).toEqual(["POST", "/v1/messages"]);
        }
        expect(
          requests.map(({ authorization, apiKey, resourceKey }) => [
            authorization,
            apiKey,
            resourceKey,
          ]),
        ).toEqual([
          ["Bearer copilot-token", undefined, undefined],
          ["Bearer foundry-token", undefined, undefined],
          ["Bearer sk-ant-oat01-oauth-token", undefined, undefined], // pragma: allowlist secret
          [undefined, "foundry-resource-key", "foundry-resource-key"],
          [undefined, "kimi-api-key", undefined],
        ]);
        expect(buildModelFetch).toHaveBeenLastCalledWith(cases.at(-1)?.model, undefined, {
          sanitizeSse: false,
        });
      },
    );
  });
});
