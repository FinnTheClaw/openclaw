import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import {
  createGovernorInstalledToolAttestor,
  governorInstalledToolDefinitionDigest,
  type GovernorInstalledToolIdentity,
  type OpaqueInstalledToolHandle,
} from "./governor-installed-tool-attestor.js";

function tool(name: string, parameters?: unknown): AgentTool {
  const selected =
    arguments.length > 1
      ? parameters
      : {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        };
  return {
    name,
    label: name,
    description: `${name} installed tool`,
    parameters: selected as AgentTool["parameters"],
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  };
}

function identity(
  value: AgentTool,
  implementationId = `installed-${value.name}-v1`,
): GovernorInstalledToolIdentity {
  return {
    toolName: value.name,
    implementationId,
    toolDefinitionDigest: governorInstalledToolDefinitionDigest(value),
    canonicalTargetPrefixes: [`campaign://${value.name}/`],
  };
}

describe("installed governor tool attestor", () => {
  it("binds exact post-resolution objects and immutable projected identities", () => {
    const read = tool("read");
    const exec = tool("exec");
    const attestor = createGovernorInstalledToolAttestor();
    const readHandle = attestor.attest({ tool: read, expected: identity(read) });
    const execHandle = attestor.attest({ tool: exec, expected: identity(exec) });

    expect(attestor.registeredTool(readHandle)).toEqual(identity(read));
    expect(Object.isFrozen(attestor.registeredTool(readHandle))).toBe(true);
    expect(Object.isFrozen(attestor.registeredTool(readHandle).canonicalTargetPrefixes)).toBe(true);
    expect(attestor.governedTools([readHandle, execHandle])).toEqual([read, exec]);
    expect(attestor.digest([readHandle, execHandle])).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestor.digest([readHandle, execHandle])).not.toBe(
      attestor.digest([execHandle, readHandle]),
    );
    expect(() => attestor.assertBound(readHandle, read)).not.toThrow();
  });

  it("rejects name, definition digest, and identity mismatches", () => {
    const read = tool("read");
    const expected = identity(read);
    for (const hostile of [
      { ...expected, toolName: "exec" },
      { ...expected, implementationId: "" },
      { ...expected, toolDefinitionDigest: "0".repeat(64) },
      { ...expected, canonicalTargetPrefixes: [] },
      { ...expected, canonicalTargetPrefixes: ["z:", "a:"] },
      { ...expected, canonicalTargetPrefixes: ["a:", "a:"] },
    ]) {
      const attestor = createGovernorInstalledToolAttestor();
      expect(() => attestor.attest({ tool: read, expected: hostile })).toThrow();
    }
  });

  it("rejects missing, truncated, non-JSON, cyclic, and unbounded schemas", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "type", { enumerable: true, get: () => "object" });
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const hostile = [
      undefined,
      { truncated: true, reason: "trajectory-depth-limit" },
      { type: "number", minimum: Number.NaN },
      { type: "object", check: () => true },
      cyclic,
      accessor,
      deep,
    ];
    for (const schema of hostile) {
      expect(() => governorInstalledToolDefinitionDigest(tool("read", schema))).toThrow();
    }
  });

  it("rejects duplicate tool objects and duplicate resolved names", () => {
    const first = tool("read");
    const second = tool("read");
    const attestor = createGovernorInstalledToolAttestor();
    attestor.attest({ tool: first, expected: identity(first) });
    expect(() => attestor.attest({ tool: first, expected: identity(first) })).toThrow(
      "GOVERNOR_INSTALLED_TOOL_DUPLICATE",
    );
    expect(() => attestor.attest({ tool: second, expected: identity(second) })).toThrow(
      "GOVERNOR_INSTALLED_TOOL_DUPLICATE",
    );
  });

  it("rejects copied handles and same-definition replacement objects", () => {
    const read = tool("read");
    const replacement = tool("read");
    const attestor = createGovernorInstalledToolAttestor();
    const handle = attestor.attest({ tool: read, expected: identity(read) });
    expect(() => attestor.registeredTool({ ...handle } as OpaqueInstalledToolHandle)).toThrow(
      "GOVERNOR_INSTALLED_TOOL_HANDLE_INVALID",
    );
    expect(() => attestor.assertBound(handle, replacement)).toThrow(
      "GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH",
    );
  });

  it("revalidates mutable schema identity before exposing or matching a tool", () => {
    const parameters = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const read = tool("read", parameters);
    const attestor = createGovernorInstalledToolAttestor();
    const handle = attestor.attest({ tool: read, expected: identity(read) });
    parameters.properties.path.type = "number";
    expect(() => attestor.assertBound(handle, read)).toThrow(
      "GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH",
    );
    expect(() => attestor.governedTools([handle])).toThrow(
      "GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH",
    );
  });

  it("rejects duplicate handles and all use after close", () => {
    const read = tool("read");
    const attestor = createGovernorInstalledToolAttestor();
    const handle = attestor.attest({ tool: read, expected: identity(read) });
    expect(() => attestor.governedTools([handle, handle])).toThrow(
      "GOVERNOR_INSTALLED_TOOL_HANDLE_DUPLICATE",
    );
    attestor.close();
    expect(() => attestor.registeredTool(handle)).toThrow(
      "GOVERNOR_INSTALLED_TOOL_ATTESTOR_CLOSED",
    );
    expect(() => attestor.attest({ tool: read, expected: identity(read) })).toThrow(
      "GOVERNOR_INSTALLED_TOOL_ATTESTOR_CLOSED",
    );
  });
});
