import { isDeepStrictEqual } from "node:util";
import type { BehaviorGovernorConfig } from "./types.behavior-governor.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const bootDecisionBrand: unique symbol = Symbol("openclaw.behavior-governor.boot-decision");
const BOOT_DECISIONS = new WeakSet<object>();

type EnabledGovernorConfig = Extract<BehaviorGovernorConfig, { enabled: true }>;
type ShadowGovernorConfig = Readonly<Omit<EnabledGovernorConfig, "mode"> & { mode: "shadow" }>;

export type BehaviorGovernorBootDecision =
  | Readonly<{
      kind: "off";
      config: BehaviorGovernorConfig | null;
      [bootDecisionBrand]: true;
    }>
  | Readonly<{
      kind: "shadow";
      config: ShadowGovernorConfig;
      [bootDecisionBrand]: true;
    }>;

function ownDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new Error("GOVERNOR_BOOT_CONFIG_ACCESSOR_REJECTED");
  }
  return descriptor.value;
}

function cloneFrozenData<T>(value: T, seen = new WeakSet<object>()): T {
  const valueType = typeof value;
  if (valueType === "function" || valueType === "symbol" || valueType === "bigint") {
    throw new Error("GOVERNOR_BOOT_CONFIG_VALUE_REJECTED");
  }
  if (valueType === "number" && !Number.isFinite(value as number)) {
    throw new Error("GOVERNOR_BOOT_CONFIG_VALUE_REJECTED");
  }
  if (value === null || valueType !== "object") {
    return value;
  }
  if (seen.has(value)) {
    throw new Error("GOVERNOR_BOOT_CONFIG_CYCLE_REJECTED");
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    if (!("value" in descriptor)) {
      throw new Error("GOVERNOR_BOOT_CONFIG_ACCESSOR_REJECTED");
    }
    if (typeof key === "symbol") {
      throw new Error("GOVERNOR_BOOT_CONFIG_DESCRIPTOR_REJECTED");
    }
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)) ||
          (key !== "length" && Number(key) >= length),
      )
    ) {
      throw new Error("GOVERNOR_BOOT_CONFIG_DESCRIPTOR_REJECTED");
    }
    const clone: unknown[] = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable) {
        throw new Error("GOVERNOR_BOOT_CONFIG_DESCRIPTOR_REJECTED");
      }
      Object.defineProperty(clone, index, {
        value: cloneFrozenData(descriptor.value, seen),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    seen.delete(value);
    return Object.freeze(clone) as unknown as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("GOVERNOR_BOOT_CONFIG_PROTOTYPE_REJECTED");
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || key === "__proto__") {
      throw new Error("GOVERNOR_BOOT_CONFIG_DESCRIPTOR_REJECTED");
    }
    Object.defineProperty(clone, key, {
      value: cloneFrozenData(descriptor.value, seen),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(clone) as T;
}

function readGovernorConfig(config: OpenClawConfig): BehaviorGovernorConfig | undefined {
  const experimental = ownDataProperty(config, "experimental");
  if (experimental === undefined) {
    return undefined;
  }
  if (!experimental || typeof experimental !== "object") {
    throw new Error("GOVERNOR_BOOT_CONFIG_INVALID");
  }
  const governor = ownDataProperty(experimental, "behaviorGovernor");
  if (governor === undefined) {
    return undefined;
  }
  if (!governor || typeof governor !== "object") {
    throw new Error("GOVERNOR_BOOT_CONFIG_INVALID");
  }
  const enabled = ownDataProperty(governor, "enabled");
  if (enabled !== true && enabled !== false) {
    throw new Error("GOVERNOR_BOOT_CONFIG_INVALID");
  }
  if (enabled === true) {
    const mode = ownDataProperty(governor, "mode");
    if (mode === "enforce") {
      throw new Error("C07_ARCHITECTURE_NOT_READY");
    }
    if (mode !== "shadow") {
      throw new Error("GOVERNOR_BOOT_CONFIG_INVALID");
    }
  }
  return cloneFrozenData(governor) as BehaviorGovernorConfig;
}

function brandDecision<T extends { kind: "off" | "shadow" }>(decision: T): T {
  Object.defineProperty(decision, bootDecisionBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(decision);
  BOOT_DECISIONS.add(decision);
  return decision;
}

/** Resolve the process-lifetime C07 posture once, before secret or state allocation. */
export function deriveBehaviorGovernorBootDecision(
  validatedConfig: OpenClawConfig,
): BehaviorGovernorBootDecision {
  const governor = readGovernorConfig(validatedConfig);
  if (!governor || governor.enabled === false) {
    return brandDecision({ kind: "off", config: governor ?? null }) as BehaviorGovernorBootDecision;
  }
  if (governor.mode !== "shadow") {
    throw new Error("GOVERNOR_BOOT_CONFIG_INVALID");
  }
  return brandDecision({
    kind: "shadow",
    config: governor as ShadowGovernorConfig,
  }) as BehaviorGovernorBootDecision;
}

export function assertBehaviorGovernorBootDecision(decision: BehaviorGovernorBootDecision): void {
  if (!BOOT_DECISIONS.has(decision)) {
    throw new Error("GOVERNOR_BOOT_DECISION_INVALID");
  }
}

/** Reject prepared/reloaded config that differs from the process-lifetime decision. */
export function assertBehaviorGovernorConfigMatchesBootDecision(
  decision: BehaviorGovernorBootDecision,
  config: OpenClawConfig,
): void {
  assertBehaviorGovernorBootDecision(decision);
  const governor = readGovernorConfig(config);
  if (decision.kind === "off") {
    if (!isDeepStrictEqual(governor ?? null, decision.config)) {
      throw new Error("GOVERNOR_GATEWAY_RESTART_REQUIRED");
    }
    return;
  }
  if (!isDeepStrictEqual(governor, decision.config)) {
    throw new Error("GOVERNOR_GATEWAY_RESTART_REQUIRED");
  }
}
