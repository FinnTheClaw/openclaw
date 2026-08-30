import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../llm/types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-transport-stream.js";
import type { StreamFn } from "./runtime/index.js";

function writeResponsesStream(res: import("node:http").ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-response-hook": "responses",
  });
  res.write(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_hook",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

function writeCompletionsStream(res: import("node:http").ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-response-hook": "completions",
  });
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl_hook",
      object: "chat.completion.chunk",
      created: 1,
      model: "hook-model",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl_hook",
      object: "chat.completion.chunk",
      created: 1,
      model: "hook-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

async function withSdkServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("chat/completions")) {
        writeCompletionsStream(res);
      } else {
        writeResponsesStream(res);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server address");
    }
    return await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function makeModel(api: Api, baseUrl: string): Model {
  return {
    id: "hook-model",
    name: "Hook Model",
    api,
    provider: "hook-provider",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 256,
  };
}

const cases: Array<{ api: Api; factory: () => StreamFn; expectedHeader: string }> = [
  {
    api: "openai-responses",
    factory: createOpenAIResponsesTransportStreamFn,
    expectedHeader: "responses",
  },
  {
    api: "azure-openai-responses",
    factory: createAzureOpenAIResponsesTransportStreamFn,
    expectedHeader: "responses",
  },
  {
    api: "openai-completions",
    factory: createOpenAICompletionsTransportStreamFn,
    expectedHeader: "completions",
  },
];

describe("OpenAI transport public response hooks", () => {
  it.each(cases)("delivers final SDK metadata through $api", async (testCase) => {
    await withSdkServer(async (baseUrl) => {
      const onResponse = vi.fn();
      const stream = await testCase.factory()(
        makeModel(testCase.api, baseUrl),
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
          tools: [],
        } as never,
        { apiKey: "test-key", onResponse } as never,
      );

      for await (const event of stream) {
        void event;
      }

      expect(onResponse).toHaveBeenCalledOnce();
      expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
        status: 200,
        headers: { "x-response-hook": testCase.expectedHeader },
      });
    });
  });
});
