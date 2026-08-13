import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { createAssistantMessageEventStream } from "./llm.js";
import type { AgentTool } from "./types.js";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as AgentTool["parameters"],
    execute: async () => ({ content: [], details: null }),
  } as AgentTool;
}

describe("Agent tool inventory ownership", () => {
  it("releases ownership when a third party replaces the inventory", () => {
    const agent = new Agent({ streamFn: () => createAssistantMessageEventStream() });
    const original = tool("original");
    const governed = tool("governed");
    const replacement = tool("replacement");

    const lease = agent.installToolInventory([original]);
    agent.state.tools = [replacement];
    lease.restore();
    expect(agent.state.tools).toEqual([replacement]);

    const nextLease = agent.installToolInventory([governed]);
    expect(agent.state.tools).toEqual([governed]);
    nextLease.restore();
    expect(agent.state.tools).toEqual([replacement]);
  });
});
