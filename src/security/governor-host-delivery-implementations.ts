/** Private, compiled delivery implementations owned by the host boundary. */
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { HostDeliveryIdentity } from "./governor-host-contracts.js";

export type HostDeliverySend = (params: {
  deliveryKey: string;
  payload: GovernorJsonValue;
}) => Promise<{ deliveryKey: string; receipt: GovernorJsonValue }>;

export type HostDeliveryImplementationMode = "production" | "test";

export type HostDeliveryImplementation = Readonly<{
  implementationId: string;
  implementationDigest: string;
  identity: HostDeliveryIdentity;
  config: GovernorJsonValue;
  send: HostDeliverySend;
}>;

type CompiledImplementation = Readonly<{
  implementationId: string;
  identity: HostDeliveryIdentity;
  createSender: (config: GovernorJsonValue) => HostDeliverySend;
}>;

const SYNTHETIC_IMPLEMENTATION_ID = "synthetic";
const syntheticAttempts = new Map<string, string[]>();
const syntheticObservableSends = new Map<string, string[]>();
const EXECUTABLE_CONFIG_KEYS = new Set([
  "callback",
  "constructor",
  "execute",
  "factory",
  "fn",
  "function",
  "handler",
  "implementation",
  "registry",
  "run",
  "send",
  "__proto__",
  "prototype",
]);

const syntheticImplementation: CompiledImplementation = Object.freeze({
  implementationId: SYNTHETIC_IMPLEMENTATION_ID,
  identity: Object.freeze({
    adapterId: "synthetic",
    version: "1",
    capability: "message.send",
  }),
  createSender:
    (config) =>
    async ({ deliveryKey, payload }) => {
      const observerKey =
        !Array.isArray(config) &&
        config !== null &&
        typeof config === "object" &&
        typeof config.observerKey === "string"
          ? config.observerKey
          : undefined;
      if (observerKey) {
        recordSyntheticAcceptedSend("test", observerKey, deliveryKey);
      }
      return {
        deliveryKey,
        receipt: {
          implementationId: SYNTHETIC_IMPLEMENTATION_ID,
          config,
          payload,
        },
      };
    },
});

function compiledImplementations(
  mode: HostDeliveryImplementationMode,
): ReadonlyMap<string, CompiledImplementation> {
  // The synthetic sender is a test fixture, never a production registration path.
  return mode === "test"
    ? new Map([[SYNTHETIC_IMPLEMENTATION_ID, syntheticImplementation]])
    : new Map();
}

function isExecutableConfigKey(key: string): boolean {
  return EXECUTABLE_CONFIG_KEYS.has(key.toLowerCase());
}

function cloneAndFreezeJson(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): GovernorJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Governor delivery config must contain finite JSON numbers (${path})`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`Governor delivery config contains an executable or non-JSON value (${path})`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Governor delivery config must not contain cycles (${path})`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key === "symbol" ||
            (key !== "length" && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)),
        )
      ) {
        throw new Error(`Governor delivery config array has non-JSON fields (${path})`);
      }
      const clone: GovernorJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`Governor delivery config array is sparse or accessor-backed (${path})`);
        }
        clone.push(cloneAndFreezeJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      Object.freeze(clone);
      return clone;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error(`Governor delivery config must contain plain JSON objects (${path})`);
    }
    const clone: Record<string, GovernorJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol" || isExecutableConfigKey(key)) {
        throw new Error(
          `Governor delivery config contains an executable field (${path}.${String(key)})`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(
          `Governor delivery config contains an accessor or hidden field (${path}.${key})`,
        );
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneAndFreezeJson(descriptor.value, `${path}.${key}`, ancestors),
        writable: true,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function createHostDeliveryImplementation(params: {
  implementationId: string;
  config: unknown;
  mode?: HostDeliveryImplementationMode;
}): HostDeliveryImplementation {
  if (typeof params.implementationId !== "string" || !params.implementationId.trim()) {
    throw new Error("Governor host delivery implementation ID is required");
  }
  const mode = params.mode ?? "production";
  if (mode !== "production" && mode !== "test") {
    throw new Error("Governor host delivery implementation mode is invalid");
  }
  if (params.implementationId === SYNTHETIC_IMPLEMENTATION_ID && mode !== "test") {
    throw new Error("Synthetic governor delivery implementation is test-only");
  }
  const compiled = compiledImplementations(mode).get(params.implementationId);
  if (!compiled) {
    throw new Error("Governor host delivery implementation ID is not allowlisted");
  }
  const config = cloneAndFreezeJson(params.config, "config", new WeakSet());
  const implementationDigest = governorDigest({
    implementationId: compiled.implementationId,
    identity: compiled.identity,
    factorySource: Function.prototype.toString.call(compiled.createSender),
  });
  return Object.freeze({
    implementationId: compiled.implementationId,
    implementationDigest,
    identity: compiled.identity,
    config,
    send: compiled.createSender(config),
  });
}

function assertSyntheticTestMode(mode: HostDeliveryImplementationMode): void {
  if (mode !== "test") {
    throw new Error("Synthetic governor delivery implementation is test-only");
  }
}

export function resetSyntheticHostDeliveryAttempts(
  mode: HostDeliveryImplementationMode,
  observerKey?: string,
): void {
  assertSyntheticTestMode(mode);
  if (observerKey === undefined) {
    syntheticAttempts.clear();
    syntheticObservableSends.clear();
  } else {
    syntheticAttempts.delete(observerKey);
    syntheticObservableSends.delete(observerKey);
  }
}

export function recordSyntheticAttempt(
  mode: HostDeliveryImplementationMode,
  observerKey: string,
  deliveryKey: string,
): void {
  assertSyntheticTestMode(mode);
  const attempts = syntheticAttempts.get(observerKey) ?? [];
  attempts.push(deliveryKey);
  syntheticAttempts.set(observerKey, attempts);
}

export function recordSyntheticAcceptedSend(
  mode: HostDeliveryImplementationMode,
  observerKey: string,
  deliveryKey: string,
): void {
  recordSyntheticAttempt(mode, observerKey, deliveryKey);
  const sends = syntheticObservableSends.get(observerKey) ?? [];
  if (!sends.includes(deliveryKey)) {
    sends.push(deliveryKey);
    syntheticObservableSends.set(observerKey, sends);
  }
}

export function getSyntheticHostDeliveryAttempts(
  mode: HostDeliveryImplementationMode,
  observerKey: string,
): readonly string[] {
  assertSyntheticTestMode(mode);
  return [...(syntheticAttempts.get(observerKey) ?? [])];
}

export function getSyntheticHostObservableSends(
  mode: HostDeliveryImplementationMode,
  observerKey: string,
): readonly string[] {
  assertSyntheticTestMode(mode);
  return [...(syntheticObservableSends.get(observerKey) ?? [])];
}
