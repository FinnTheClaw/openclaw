// Bounds JSON-shaped governor input before secret scanning or serialization.
import type { GovernorJsonValue } from "./canonical-json.js";

export type GovernorJsonResourceLimits = Readonly<{
  maxUtf8Bytes: number;
  maxStringBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxProperties: number;
  maxArrayLength: number;
  maxCollections: number;
}>;

export const DEFAULT_GOVERNOR_JSON_RESOURCE_LIMITS: GovernorJsonResourceLimits = Object.freeze({
  maxUtf8Bytes: 512 * 1024,
  maxStringBytes: 64 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
  maxProperties: 4_000,
  maxArrayLength: 1_000,
  maxCollections: 2_000,
});

export type GovernorResourceViolation =
  | "invalid_limits"
  | "unsupported_type"
  | "accessor"
  | "proxy_or_unreadable"
  | "prototype"
  | "prototype_pollution_key"
  | "cycle"
  | "non_finite_number"
  | "invalid_unicode"
  | "max_utf8_bytes"
  | "max_string_bytes"
  | "max_depth"
  | "max_nodes"
  | "max_properties"
  | "max_array_length"
  | "max_collections";

/**
 * Bounded, structured failure. It deliberately contains no input path or value:
 * untrusted keys and payloads must not be echoed through an error boundary.
 */
export class GovernorResourceGuardError extends Error {
  readonly code = "governor_resource_limit" as const;

  constructor(readonly reason: GovernorResourceViolation) {
    super(`Governor JSON resource guard rejected input (${reason})`);
    this.name = "GovernorResourceGuardError";
  }
}

type StackFrame =
  | { kind: "enter"; value: unknown; depth: number }
  | { kind: "leave"; value: object };

function fail(reason: GovernorResourceViolation): never {
  throw new GovernorResourceGuardError(reason);
}

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(
  overrides: Partial<GovernorJsonResourceLimits> | undefined,
): GovernorJsonResourceLimits {
  const limits = { ...DEFAULT_GOVERNOR_JSON_RESOURCE_LIMITS, ...overrides };
  if (
    !positiveLimit(limits.maxUtf8Bytes) ||
    !positiveLimit(limits.maxStringBytes) ||
    !positiveLimit(limits.maxDepth) ||
    !positiveLimit(limits.maxNodes) ||
    !positiveLimit(limits.maxProperties) ||
    !positiveLimit(limits.maxArrayLength) ||
    !positiveLimit(limits.maxCollections)
  ) {
    fail("invalid_limits");
  }
  return limits;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail("invalid_unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid_unicode");
    }
  }
}

function assertPlainObject(value: object): void {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("proxy_or_unreadable");
  }
  if (prototype !== null && prototype !== Object.prototype) {
    fail("prototype");
  }
}

function assertPropertyKey(key: PropertyKey): asserts key is string {
  if (typeof key !== "string") {
    fail("unsupported_type");
  }
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    fail("prototype_pollution_key");
  }
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}

function readDescriptors(value: object): {
  keys: readonly PropertyKey[];
  descriptors: PropertyDescriptorMap;
} {
  try {
    return { keys: Reflect.ownKeys(value), descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return fail("proxy_or_unreadable");
  }
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (!descriptor) {
    fail("proxy_or_unreadable");
  }
  if (descriptor.get || descriptor.set) {
    fail("accessor");
  }
  if (!Object.hasOwn(descriptor, "value")) {
    fail("proxy_or_unreadable");
  }
  if (!descriptor.enumerable) {
    fail("unsupported_type");
  }
}

function addStringBytes(
  value: string,
  limits: GovernorJsonResourceLimits,
  state: { bytes: number },
): void {
  assertUnicode(value);
  const bytes = utf8Bytes(value);
  if (bytes > limits.maxStringBytes) {
    fail("max_string_bytes");
  }
  state.bytes += bytes;
  if (state.bytes > limits.maxUtf8Bytes) {
    fail("max_utf8_bytes");
  }
}

/**
 * Iteratively validates JSON-shaped input without JSON.stringify, recursion,
 * getter invocation, or trusting caller-provided prototypes.
 */
export function assertGovernorJsonResources(
  value: unknown,
  overrides?: Partial<GovernorJsonResourceLimits>,
): GovernorJsonValue {
  const limits = resolveLimits(overrides);
  const state = { bytes: 0, nodes: 0, properties: 0, collections: 0 };
  const stack: StackFrame[] = [{ kind: "enter", value, depth: 0 }];
  const active = new WeakSet<object>();

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      break;
    }
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }

    const current = frame.value;
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) {
      fail("max_nodes");
    }
    if (frame.depth > limits.maxDepth) {
      fail("max_depth");
    }
    if (current === null || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "string") {
      addStringBytes(current, limits, state);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail("non_finite_number");
      }
      continue;
    }
    if (typeof current !== "object") {
      fail("unsupported_type");
    }
    if (active.has(current)) {
      fail("cycle");
    }
    active.add(current);
    state.collections += 1;
    if (state.collections > limits.maxCollections) {
      fail("max_collections");
    }

    if (Array.isArray(current)) {
      const { keys, descriptors } = readDescriptors(current);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set) {
        fail("proxy_or_unreadable");
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxArrayLength) {
        fail("max_array_length");
      }
      const children: unknown[] = [];
      for (const key of keys) {
        if (key === "length") {
          continue;
        }
        assertPropertyKey(key);
        if (!isArrayIndex(key)) {
          fail("unsupported_type");
        }
        const descriptor = descriptors[key];
        assertDataProperty(descriptor);
        state.properties += 1;
        if (state.properties > limits.maxProperties) {
          fail("max_properties");
        }
        addStringBytes(key, limits, state);
        children.push(descriptor.value);
      }
      stack.push({ kind: "leave", value: current });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "enter", value: children[index], depth: frame.depth + 1 });
      }
      continue;
    }

    assertPlainObject(current);
    const { keys, descriptors } = readDescriptors(current);
    const children: unknown[] = [];
    for (const key of keys) {
      assertPropertyKey(key);
      const descriptor = descriptors[key];
      assertDataProperty(descriptor);
      state.properties += 1;
      if (state.properties > limits.maxProperties) {
        fail("max_properties");
      }
      addStringBytes(key, limits, state);
      children.push(descriptor.value);
    }
    stack.push({ kind: "leave", value: current });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "enter", value: children[index], depth: frame.depth + 1 });
    }
  }
  return value as GovernorJsonValue;
}
