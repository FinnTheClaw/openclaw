import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "../../packages/agent-core/src/llm.js";
import type { AgentTool, StreamFn } from "../../src/agents/runtime/index.js";

export const governorAgentLoopFixtureModel: Model = {
  id: "governor-loop-fixture-model",
  name: "Governor Loop Fixture Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2_000,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function governorAgentLoopAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: governorAgentLoopFixtureModel.api,
    provider: governorAgentLoopFixtureModel.provider,
    model: governorAgentLoopFixtureModel.id,
    usage,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

export function governorAgentLoopScriptedStream(next: () => AssistantMessage): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = next();
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };
}

export function governorAgentLoopTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({ key: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute,
  };
}
