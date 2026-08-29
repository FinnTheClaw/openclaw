import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

function makeRootUnionRuntime(): SessionMcpRuntime {
  const inputSchema = {
    type: "object",
    title: "MessagesReplyInput",
    additionalProperties: false,
    required: ["thread_id"],
    properties: {
      thread_id: { type: "string", minLength: 1, maxLength: 128 },
      body: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      body_file: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      task_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      turn_grant_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
    },
    anyOf: [
      { required: ["body"], properties: { body: { type: "string" } } },
      { required: ["body_file"], properties: { body_file: { type: "string" } } },
    ],
  };
  const tools: McpCatalogTool[] = [
    {
      serverName: "aihub",
      safeServerName: "aihub",
      toolName: "messages_reply",
      inputSchema: inputSchema as McpCatalogTool["inputSchema"],
      fallbackDescription: "Reply to a message",
    },
  ];
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      aihub: {
        serverName: "aihub",
        launchSummary: "aihub",
        toolCount: tools.length,
        supportsParallelToolCalls: false,
      },
    },
    tools,
  };
  return {
    sessionId: "root-union",
    workspaceDir: "/tmp",
    configFingerprint: "root-union",
    createdAt: 0,
    lastUsedAt: 0,
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: () => {},
    callTool: async () => ({ content: [], isError: false }),
    dispose: async () => {},
  };
}

describe("MCP root-union materialization", () => {
  it("keeps root fields callable when an MCP input schema uses a root union (#128743)", async () => {
    const runtime = await materializeBundleMcpToolsForRun({ runtime: makeRootUnionRuntime() });
    const tool = runtime.tools[0]!;
    expect(tool, "runtime.tools[0] test invariant").toBeDefined();

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-inline-body",
        name: tool.name,
        arguments: { thread_id: "thread-1", body: "hello" },
      }),
    ).not.toThrow();
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-body-file",
        name: tool.name,
        arguments: { thread_id: "thread-1", body_file: "/tmp/body.md" },
      }),
    ).not.toThrow();
  });
});
