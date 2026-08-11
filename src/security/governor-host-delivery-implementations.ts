/** Private, compiled delivery implementations owned by the host boundary. */
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import { createCanaryHostSender } from "./governor-host-canary-sink.js";
import {
  createIMessageHostSender,
  createSignalHostSender,
  type GovernorHostDeliveryRuntime,
  type HostCompiledSender,
  type HostPrimitiveDeliveryResult,
  type HostPrimitiveReconciliationResult,
} from "./governor-host-channel-delivery.js";
import type { HostDeliveryIdentity } from "./governor-host-contracts.js";
import { governorDeliveryBuildManifestDigest } from "./governor-host-delivery-build-manifest.js";

export type HostDeliverySend = (params: {
  deliveryKey: string;
  payload: GovernorJsonValue;
}) => Promise<HostPrimitiveDeliveryResult>;

export type HostDeliveryImplementationMode = "production" | "test";

export type HostDeliveryImplementation = Readonly<{
  implementationId: string;
  implementationDigest: string;
  identity: HostDeliveryIdentity;
  config: GovernorJsonValue;
  channel: HostCompiledSender["channel"];
  accountId: string;
  normalizedTarget: string;
  mode: HostCompiledSender["mode"];
  send: HostDeliverySend;
  reconcile: (params: {
    deliveryKey: string;
    payloadDigest: string;
  }) => Promise<HostPrimitiveReconciliationResult>;
}>;

type CompiledImplementation = Readonly<{
  implementationId: string;
  identity: HostDeliveryIdentity;
  createSender: (
    config: GovernorJsonValue,
    runtime?: GovernorHostDeliveryRuntime,
  ) => HostCompiledSender;
}>;

const SYNTHETIC_IMPLEMENTATION_ID = "synthetic";
export const GOVERNOR_CANARY_IMPLEMENTATION_ID = "openclaw.canary.disposable.v1";
export const GOVERNOR_SIGNAL_IMPLEMENTATION_ID = "openclaw.channel.signal.v1";
export const GOVERNOR_IMESSAGE_IMPLEMENTATION_ID = "openclaw.channel.imessage.v1";
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
  createSender: (config) =>
    Object.freeze({
      channel: "canary" as const,
      accountId: "synthetic",
      normalizedTarget: "synthetic",
      mode: "active" as const,
      send: async ({ deliveryKey, payload }) => {
        const throwDeliveryKey =
          !Array.isArray(config) &&
          config !== null &&
          typeof config === "object" &&
          typeof config.throwDeliveryKey === "string"
            ? config.throwDeliveryKey
            : undefined;
        if (
          throwDeliveryKey === deliveryKey ||
          (!Array.isArray(config) &&
            config !== null &&
            typeof config === "object" &&
            config.throwBeforeSend === true)
        ) {
          throw new Error("Synthetic governor delivery interrupted before observable send");
        }
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
          status: "sent" as const,
          providerReceipt: {
            implementationId: SYNTHETIC_IMPLEMENTATION_ID,
            config,
            payload,
          },
        };
      },
      reconcile: async ({ deliveryKey }) => {
        const observerKey =
          !Array.isArray(config) &&
          config !== null &&
          typeof config === "object" &&
          typeof config.observerKey === "string"
            ? config.observerKey
            : undefined;
        if (
          observerKey &&
          (syntheticObservableSends.get(observerKey) ?? []).includes(deliveryKey)
        ) {
          return {
            status: "sent" as const,
            providerReceipt: { implementationId: SYNTHETIC_IMPLEMENTATION_ID, deliveryKey },
          };
        }
        return { status: "unresolved" as const };
      },
    }),
});

const canaryImplementation: CompiledImplementation = Object.freeze({
  implementationId: GOVERNOR_CANARY_IMPLEMENTATION_ID,
  identity: Object.freeze({ adapterId: "canary", version: "1", capability: "message.send" }),
  createSender: (config, runtime) => {
    if (!runtime) {
      throw new Error("Governor canary delivery runtime is required");
    }
    return createCanaryHostSender(config, runtime.stateDir);
  },
});

const signalImplementation: CompiledImplementation = Object.freeze({
  implementationId: GOVERNOR_SIGNAL_IMPLEMENTATION_ID,
  identity: Object.freeze({ adapterId: "signal", version: "1", capability: "message.send" }),
  createSender: (config, runtime) => {
    if (!runtime) {
      throw new Error("Governor Signal delivery runtime is required");
    }
    return createSignalHostSender(config, runtime);
  },
});

const imessageImplementation: CompiledImplementation = Object.freeze({
  implementationId: GOVERNOR_IMESSAGE_IMPLEMENTATION_ID,
  identity: Object.freeze({ adapterId: "imessage", version: "1", capability: "message.send" }),
  createSender: (config, runtime) => {
    if (!runtime) {
      throw new Error("Governor iMessage delivery runtime is required");
    }
    return createIMessageHostSender(config, runtime);
  },
});

function compiledImplementations(
  mode: HostDeliveryImplementationMode,
): ReadonlyMap<string, CompiledImplementation> {
  // The synthetic sender is a test fixture, never a production registration path.
  const production = [canaryImplementation, signalImplementation, imessageImplementation] as const;
  return new Map(
    (mode === "test" ? [...production, syntheticImplementation] : production).map((item) => [
      item.implementationId,
      item,
    ]),
  );
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
  runtime?: GovernorHostDeliveryRuntime;
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
  const buildManifestDigest = governorDeliveryBuildManifestDigest();
  const sender = compiled.createSender(config, params.runtime);
  const implementationDigest = governorDigest({
    implementationId: compiled.implementationId,
    identity: compiled.identity,
    buildManifestDigest,
  });
  return Object.freeze({
    implementationId: compiled.implementationId,
    implementationDigest,
    identity: compiled.identity,
    config,
    channel: sender.channel,
    accountId: sender.accountId,
    normalizedTarget: sender.normalizedTarget,
    mode: sender.mode,
    send: sender.send,
    reconcile: sender.reconcile,
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
