import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-readonly.js";

export const C02_REDUNDANT_SUCCESSFUL_TOOL_CALL = "C02_REDUNDANT_SUCCESSFUL_TOOL_CALL";

const REACTIVE_MESSAGE =
  "A duplicate successful tool call was blocked. Continue with a different action.";
const MAX_DEPTH = 16;
const MAX_ENTRIES = 256;

type SuccessfulCall = Readonly<{ toolName: string; argsDigest: string }>;

function canonicalArgs(value: unknown, depth = 0): GovernorJsonValue | undefined {
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object":
      break;
    default:
      return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) {
      return undefined;
    }
    const items: GovernorJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return undefined;
      }
      const item = canonicalArgs(value[index], depth + 1);
      if (item === undefined) {
        return undefined;
      }
      items.push(item);
    }
    return items;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ENTRIES || Object.getOwnPropertySymbols(value).length > 0) {
    return undefined;
  }
  const result: Record<string, GovernorJsonValue> = {};
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      return undefined;
    }
    const item = canonicalArgs(descriptor.value, depth + 1);
    if (item === undefined) {
      return undefined;
    }
    result[key] = item;
  }
  return result;
}

function callIdentity(toolName: string, args: unknown): SuccessfulCall | undefined {
  try {
    const canonical = canonicalArgs(args);
    return canonical === undefined
      ? undefined
      : { toolName, argsDigest: governorDigest(canonical) };
  } catch {
    return undefined;
  }
}

function sameCall(left: SuccessfulCall, right: SuccessfulCall): boolean {
  return left.toolName === right.toolName && left.argsDigest === right.argsDigest;
}

/** Per-run only: retains digests, never raw arguments or tool results. */
export function createGovernorC02ProductionProfileScope(
  run: GovernorAgentLoopRunInput,
  onDispose?: (scope: GovernorAgentLoopRunScope) => void,
): GovernorAgentLoopRunScope {
  const pending = new WeakMap<object, SuccessfulCall>();
  let installedTools: readonly AgentTool[] = Object.freeze([]);
  let candidate: SuccessfulCall | undefined;
  let reactivePending = false;
  let disposed = false;

  let scope: GovernorAgentLoopRunScope;
  scope = Object.freeze({
    taskId: run.runId,
    mode: "enforce" as const,
    disposition: "runnable" as const,
    prepareTools(tools: readonly AgentTool[]) {
      installedTools = Object.freeze([...tools]);
    },
    beforeTool(request) {
      const identity = callIdentity(request.toolName, request.args);
      if (identity && candidate && sameCall(candidate, identity)) {
        reactivePending = true;
        return { kind: "block" as const, reasonCode: C02_REDUNDANT_SUCCESSFUL_TOOL_CALL };
      }
      candidate = undefined;
      if (!identity) {
        return { kind: "allow" as const };
      }
      const opaque = {};
      pending.set(opaque, identity);
      return { kind: "allow" as const, ticket: Object.freeze({ opaque }) };
    },
    afterTool(observation) {
      const identity = observation.ticket ? pending.get(observation.ticket.opaque) : undefined;
      if (observation.ticket) {
        pending.delete(observation.ticket.opaque);
      }
      if (identity && !observation.isError) {
        candidate = identity;
      }
    },
    afterTurn() {
      if (reactivePending) {
        reactivePending = false;
        return { kind: "continue" as const, message: REACTIVE_MESSAGE };
      }
      return { kind: "complete" as const };
    },
    interrupt() {},
    assertTerminal() {},
    governedTools() {
      return installedTools;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      candidate = undefined;
      reactivePending = false;
      onDispose?.(scope);
    },
  });
  return scope;
}
