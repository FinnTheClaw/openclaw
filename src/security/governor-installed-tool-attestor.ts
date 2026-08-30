import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SCHEMA_BYTES = 1_048_576;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;

declare const installedToolHandleBrand: unique symbol;
export type OpaqueInstalledToolHandle = Readonly<{
  [installedToolHandleBrand]: "governor-installed-tool";
}>;

export type GovernorInstalledToolIdentity = Readonly<{
  toolName: string;
  implementationId: string;
  toolDefinitionDigest: string;
  canonicalTargetPrefixes: readonly string[];
}>;

export type GovernorInstalledToolAttestation = Readonly<{
  tool: AgentTool;
  expected: GovernorInstalledToolIdentity;
}>;

export type GovernorInstalledToolAttestor = Readonly<{
  attest(input: GovernorInstalledToolAttestation): OpaqueInstalledToolHandle;
  registeredTool(handle: OpaqueInstalledToolHandle): GovernorInstalledToolIdentity;
  assertBound(handle: OpaqueInstalledToolHandle, tool: AgentTool): void;
  governedTools(handles: readonly OpaqueInstalledToolHandle[]): readonly AgentTool[];
  digest(handles: readonly OpaqueInstalledToolHandle[]): string;
  close(): void;
}>;

type Entry = Readonly<{
  tool: AgentTool;
  identity: GovernorInstalledToolIdentity;
}>;

function validText(value: string, max: number): boolean {
  return (
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  );
}

function cloneSchema(value: unknown): GovernorJsonValue {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): GovernorJsonValue => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_BOUNDED");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
      }
      return item;
    }
    if (typeof item !== "object" || active.has(item)) {
      throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
    }
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) {
          throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
        }
        return item.map((child) => visit(child, depth + 1));
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
      }
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const result: Record<string, GovernorJsonValue> = {};
      for (const key of Object.keys(descriptors).toSorted()) {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_INVALID");
        }
        result[key] = visit(descriptor.value, depth + 1);
      }
      if (result.truncated === true || result.reason === "trajectory-depth-limit") {
        throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_TRUNCATED");
      }
      return result;
    } finally {
      active.delete(item);
    }
  };
  const schema = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) {
    throw new Error("GOVERNOR_INSTALLED_TOOL_SCHEMA_BOUNDED");
  }
  return schema;
}

function definition(tool: AgentTool): GovernorJsonValue {
  if (!validText(tool.name, 256) || !validText(tool.description, 16_384)) {
    throw new Error("GOVERNOR_INSTALLED_TOOL_DEFINITION_INVALID");
  }
  return {
    name: tool.name,
    description: tool.description,
    schema: cloneSchema(tool.parameters),
  };
}

export function governorInstalledToolDefinitionDigest(tool: AgentTool): string {
  return governorDigest(definition(tool));
}

function snapshotIdentity(value: GovernorInstalledToolIdentity): GovernorInstalledToolIdentity {
  if (
    !validText(value.toolName, 256) ||
    !validText(value.implementationId, 256) ||
    !SHA256.test(value.toolDefinitionDigest) ||
    value.canonicalTargetPrefixes.length === 0 ||
    value.canonicalTargetPrefixes.some((prefix) => !validText(prefix, 2048)) ||
    new Set(value.canonicalTargetPrefixes).size !== value.canonicalTargetPrefixes.length ||
    value.canonicalTargetPrefixes.some(
      (prefix, index) => index > 0 && prefix <= value.canonicalTargetPrefixes[index - 1]!,
    )
  ) {
    throw new Error("GOVERNOR_INSTALLED_TOOL_IDENTITY_INVALID");
  }
  return Object.freeze({
    toolName: value.toolName,
    implementationId: value.implementationId,
    toolDefinitionDigest: value.toolDefinitionDigest,
    canonicalTargetPrefixes: Object.freeze([...value.canonicalTargetPrefixes]),
  });
}

export function createGovernorInstalledToolAttestor(): GovernorInstalledToolAttestor {
  const byTool = new WeakMap<object, Entry>();
  const byHandle = new WeakMap<object, Entry>();
  const names = new Set<string>();
  let closed = false;

  const entryFor = (handle: OpaqueInstalledToolHandle): Entry => {
    if (closed) {
      throw new Error("GOVERNOR_INSTALLED_TOOL_ATTESTOR_CLOSED");
    }
    const entry = byHandle.get(handle);
    if (!entry) {
      throw new Error("GOVERNOR_INSTALLED_TOOL_HANDLE_INVALID");
    }
    return entry;
  };
  const assertCurrent = (entry: Entry, tool: AgentTool): void => {
    if (
      entry.tool !== tool ||
      byTool.get(tool) !== entry ||
      tool.name !== entry.identity.toolName ||
      governorInstalledToolDefinitionDigest(tool) !== entry.identity.toolDefinitionDigest
    ) {
      throw new Error("GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH");
    }
  };

  return Object.freeze({
    attest(input) {
      if (closed) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_ATTESTOR_CLOSED");
      }
      const identity = snapshotIdentity(input.expected);
      if (byTool.has(input.tool) || names.has(identity.toolName)) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_DUPLICATE");
      }
      if (
        input.tool.name !== identity.toolName ||
        governorInstalledToolDefinitionDigest(input.tool) !== identity.toolDefinitionDigest
      ) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_BINDING_MISMATCH");
      }
      const handle = Object.freeze({}) as OpaqueInstalledToolHandle;
      const entry = Object.freeze({ tool: input.tool, identity });
      byTool.set(input.tool, entry);
      byHandle.set(handle, entry);
      names.add(identity.toolName);
      return handle;
    },
    registeredTool(handle) {
      return entryFor(handle).identity;
    },
    assertBound(handle, tool) {
      assertCurrent(entryFor(handle), tool);
    },
    governedTools(handles) {
      if (new Set(handles).size !== handles.length) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_HANDLE_DUPLICATE");
      }
      return Object.freeze(
        handles.map((handle) => {
          const entry = entryFor(handle);
          assertCurrent(entry, entry.tool);
          return entry.tool;
        }),
      );
    },
    digest(handles) {
      const identities = handles.map((handle) => entryFor(handle).identity);
      if (new Set(handles).size !== handles.length) {
        throw new Error("GOVERNOR_INSTALLED_TOOL_HANDLE_DUPLICATE");
      }
      return governorDigest(
        identities.map((identity) => ({
          toolName: identity.toolName,
          implementationId: identity.implementationId,
          toolDefinitionDigest: identity.toolDefinitionDigest,
          canonicalTargetPrefixes: [...identity.canonicalTargetPrefixes],
        })) as GovernorJsonValue,
      );
    },
    close() {
      closed = true;
      names.clear();
    },
  });
}
