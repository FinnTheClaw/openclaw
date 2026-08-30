import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { normalizeToolParameters } from "../agents/agent-tools.schema.js";

export function normalizedC02GatewayRegistry(): readonly AgentTool[] {
  const tool = (name: "read" | "exec", argument: "path" | "command"): AgentTool =>
    normalizeToolParameters({
      name,
      label: name,
      description: `Gateway-installed ${name}`,
      parameters: {
        type: "object",
        properties: { [argument]: { type: "string" } },
        required: [argument],
        additionalProperties: false,
      },
      execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: null }),
    });
  return Object.freeze([tool("read", "path"), tool("exec", "command")]);
}
