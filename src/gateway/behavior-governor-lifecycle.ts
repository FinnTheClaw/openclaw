import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getMemoryCapabilityRegistration } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStateDir } from "../config/paths.js";
import type {
  BehaviorGovernorConfig,
  BehaviorGovernorAgentLoopConfig,
} from "../config/types.behavior-governor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import {
  isOwnedGovernorMemoryBackend,
  isOwnedGovernorMemoryCapability,
} from "../plugins/memory-governor-capability.js";
import { createInertMemoryGovernorBackend } from "../plugins/memory-state.js";
import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import type {
  GovernorHostIntegrationConfiguration,
  GovernorHostRuntime,
} from "../security/governor-host-bootstrap.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";

type EnabledBehaviorGovernorConfig = Extract<BehaviorGovernorConfig, { enabled: true }>;
export type GatewayBehaviorGovernorPolicy = Readonly<
  Omit<EnabledBehaviorGovernorConfig, "secretRefs">
>;

export type GatewayBehaviorGovernorHostFactory = (params: {
  config: GatewayBehaviorGovernorPolicy;
  stateDir: string;
  secrets: Readonly<{
    identityHmacKey: string;
    evidenceAdmissionKey: string;
    receiptSigningKey: string;
    ledgerSigningKey: string;
    deploymentIdentity: string;
    evidenceAdmissionKeyId: string;
  }>;
}) =>
  | {
      capabilities: readonly GovernorCapabilityDefinition[];
      integrations: GovernorHostIntegrationConfiguration;
      /**
       * Optional host-owned rollback/close for allocations made by the
       * compiled integration factory.  Factories that return no handle must
       * be pure registry lookups and may not allocate process or persistence
       * resources.
       */
      close?: () => void | Promise<void>;
    }
  | Promise<{
      capabilities: readonly GovernorCapabilityDefinition[];
      integrations: GovernorHostIntegrationConfiguration;
      close?: () => void | Promise<void>;
    }>;

export type GatewayBehaviorGovernorLifecycle = Readonly<{
  apply: (
    config: OpenClawConfig,
    secretSnapshot: GatewayBehaviorGovernorSecretSnapshot,
  ) => Promise<void>;
  close: () => Promise<void>;
  freeze: () => Promise<void>;
}>;

function aggregateWithCause(errors: unknown[], message: string, cause: unknown): AggregateError {
  return new AggregateError(errors, message, { cause });
}

export type GatewayBehaviorGovernorSecretSnapshot = Readonly<{
  env: NodeJS.ProcessEnv;
  generation: string;
  sourceConfig: EnabledBehaviorGovernorConfig;
  config: Readonly<{ secretRefs: Readonly<Record<string, string>> }>;
}>;

const SECRET_ENV_NAMES = {
  identityHmacKey: "OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY",
  evidenceAdmissionKey: "OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY",
  receiptSigningKey: "OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY",
  ledgerSigningKey: "OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY",
  deploymentIdentity: "OPENCLAW_GOVERNOR_DEPLOYMENT_ID",
} as const;

function enabledConfig(config: OpenClawConfig): EnabledBehaviorGovernorConfig | undefined {
  const value = config.experimental?.behaviorGovernor;
  return value?.enabled === true ? value : undefined;
}

function loopConfig(config: EnabledBehaviorGovernorConfig): BehaviorGovernorAgentLoopConfig & {
  mode: EnabledBehaviorGovernorConfig["mode"];
} {
  return { ...config.agentLoop, mode: config.mode };
}

function readPreparedGovernorEnvironment(params: {
  sourceConfig: EnabledBehaviorGovernorConfig;
  snapshotConfig: Readonly<{ secretRefs: Readonly<Record<string, string>> }>;
  env: NodeJS.ProcessEnv;
}): {
  env: NodeJS.ProcessEnv;
  secrets: {
    identityHmacKey: string;
    evidenceAdmissionKey: string;
    receiptSigningKey: string;
    ledgerSigningKey: string;
    deploymentIdentity: string;
    evidenceAdmissionKeyId: string;
  };
} {
  for (const field of [
    "identityHmacKey",
    "evidenceAdmissionKey",
    "receiptSigningKey",
    "ledgerSigningKey",
    "deploymentIdentity",
  ] as const) {
    if (!isSecretRef(params.sourceConfig.secretRefs[field])) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_REF_INVALID");
    }
  }
  const resolvedRefs = params.snapshotConfig.secretRefs;
  const read = (field: string): string => {
    const value = resolvedRefs[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_INCOMPLETE");
    }
    return value;
  };
  const resolved: NodeJS.ProcessEnv = params.env.NODE_ENV ? { NODE_ENV: params.env.NODE_ENV } : {};
  const secrets = Object.freeze({
    identityHmacKey: read("identityHmacKey"),
    evidenceAdmissionKey: read("evidenceAdmissionKey"),
    receiptSigningKey: read("receiptSigningKey"),
    ledgerSigningKey: read("ledgerSigningKey"),
    deploymentIdentity: read("deploymentIdentity"),
    evidenceAdmissionKeyId:
      typeof resolvedRefs.evidenceAdmissionKeyId === "string" &&
      resolvedRefs.evidenceAdmissionKeyId.trim()
        ? resolvedRefs.evidenceAdmissionKeyId
        : "v1",
  });
  for (const [field, envName] of Object.entries(SECRET_ENV_NAMES) as Array<
    [keyof typeof SECRET_ENV_NAMES, string]
  >) {
    resolved[envName] = secrets[field];
  }
  if (secrets.evidenceAdmissionKeyId) {
    resolved.OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID = secrets.evidenceAdmissionKeyId;
  }
  return { env: resolved, secrets };
}

export function createGatewayBehaviorGovernorLifecycle(params: {
  stateDir?: string;
  hostFactory?: GatewayBehaviorGovernorHostFactory;
}): GatewayBehaviorGovernorLifecycle {
  let active:
    | {
        key: string;
        runtime: GovernorHostRuntime;
        hostClose?: () => void | Promise<void>;
        memoryClose?: () => void | Promise<void>;
        closeFailure?: AggregateError;
      }
    | undefined;
  let initialized = false;
  let serial = Promise.resolve();

  const closeUnsafe = async () => {
    const current = active;
    if (!current) {
      return;
    }
    if (current.closeFailure) {
      throw current.closeFailure;
    }
    const errors: unknown[] = [];
    try {
      if (current.runtime.closeAsync) {
        await current.runtime.closeAsync();
      } else {
        current.runtime.close();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await current.hostClose?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await current.memoryClose?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      current.closeFailure = new AggregateError(errors, "GOVERNOR_GATEWAY_CLOSE_FAILED");
      throw current.closeFailure;
    }
    active = undefined;
  };

  const freezeUnsafe = () => {
    active?.runtime.freeze();
  };

  const applyUnsafe = async (
    config: OpenClawConfig,
    secretSnapshot: GatewayBehaviorGovernorSecretSnapshot,
  ) => {
    const requestedGovernor = enabledConfig(config);
    if (!requestedGovernor) {
      if (initialized && active) {
        throw new Error("GOVERNOR_GATEWAY_RESTART_REQUIRED");
      }
      initialized = true;
      return;
    }
    const governor = secretSnapshot.sourceConfig;
    if (
      !isDeepStrictEqual(
        { mode: requestedGovernor.mode, agentLoop: requestedGovernor.agentLoop },
        { mode: governor.mode, agentLoop: governor.agentLoop },
      )
    ) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_CONFIG_MISMATCH");
    }
    const key = `${secretSnapshot.generation}:${JSON.stringify(governor)}`;
    if (active?.key === key) {
      return;
    }
    if (initialized) {
      throw new Error("GOVERNOR_GATEWAY_RESTART_REQUIRED");
    }
    initialized = true;
    if (!params.hostFactory) {
      throw new Error("GOVERNOR_GATEWAY_HOST_INTEGRATION_REQUIRED");
    }
    if (!secretSnapshot.generation.trim()) {
      throw new Error("GOVERNOR_GATEWAY_SECRET_SNAPSHOT_REQUIRED");
    }
    const stateRoot = path.resolve(params.stateDir ?? resolveStateDir(secretSnapshot.env));
    const stateDir = path.join(stateRoot, "governor");
    if (path.relative(stateRoot, stateDir).startsWith("..")) {
      throw new Error("GOVERNOR_GATEWAY_STATE_ROOT_INVALID");
    }
    const resolved = readPreparedGovernorEnvironment({
      sourceConfig: governor,
      snapshotConfig: secretSnapshot.config,
      env: secretSnapshot.env,
    });
    const { secretRefs: _secretRefs, ...policy } = governor;
    const factoryConfig = deepFreeze(structuredClone(policy));
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const resolvedStateRoot = fs.realpathSync(stateRoot);
      const resolvedStateDir = fs.realpathSync(stateDir);
      const relativeStateDir = path.relative(resolvedStateRoot, resolvedStateDir);
      if (
        !relativeStateDir ||
        relativeStateDir.startsWith("..") ||
        path.isAbsolute(relativeStateDir) ||
        fs.lstatSync(stateDir).isSymbolicLink()
      ) {
        throw new Error("GOVERNOR_GATEWAY_STATE_ROOT_INVALID");
      }
      fs.chmodSync(stateDir, 0o700);
    } catch (error) {
      try {
        if (fs.readdirSync(stateDir).length === 0) {
          fs.rmdirSync(stateDir);
        }
      } catch {
        // Do not recursively remove persistent state during failed startup.
      }
      throw error;
    }
    let host: Awaited<ReturnType<NonNullable<typeof params.hostFactory>>> | undefined;
    let runtime: GovernorHostRuntime | null = null;
    let memoryClose: (() => void | Promise<void>) | undefined;
    try {
      host = await params.hostFactory({
        config: factoryConfig,
        stateDir,
        secrets: resolved.secrets,
      });
      const { createGovernorHostRuntimeIfEnabled } =
        await import("../security/governor-host-bootstrap.js");
      const suppliedMemory = host.integrations.memory;
      const registration = getMemoryCapabilityRegistration();
      const memoryCapability =
        registration?.pluginId === "memory-lancedb" &&
        registration.capability.governorMemory &&
        isOwnedGovernorMemoryCapability(registration.capability.governorMemory)
          ? registration.capability.governorMemory
          : undefined;
      const registeredMemory =
        governor.mode === "enforce"
          ? memoryCapability?.createBackend({
              mode: "enforce",
              authorityBindingKey: resolved.secrets.ledgerSigningKey,
            })
          : undefined;
      const memory =
        governor.mode === "shadow"
          ? createInertMemoryGovernorBackend()
          : suppliedMemory
            ? undefined
            : registeredMemory;
      if (governor.mode === "enforce" && (!memory || !isOwnedGovernorMemoryBackend(memory))) {
        throw new Error("GOVERNOR_GATEWAY_MEMORY_CAPABILITY_REQUIRED");
      }
      if (memory && memory === registeredMemory && memory.close) {
        memoryClose = () => memory.close?.();
      }
      runtime = createGovernorHostRuntimeIfEnabled({
        enabled: true,
        env: { ...resolved.env, OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        capabilities: host.capabilities,
        integrations: {
          ...host.integrations,
          ...(memory ? { memory } : {}),
          agentLoop: loopConfig(governor) as GovernorAgentLoopConfiguration,
        },
      });
      if (!runtime) {
        throw new Error("GOVERNOR_GATEWAY_RUNTIME_NOT_CREATED");
      }
      active = { key, runtime, hostClose: host.close, memoryClose };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        if (runtime?.closeAsync) {
          await runtime.closeAsync();
        } else {
          runtime?.close();
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await host?.close?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await memoryClose?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        if (fs.readdirSync(stateDir).length === 0) {
          fs.rmdirSync(stateDir);
        }
      } catch {
        // Persistent governor state is never recursively removed during recovery.
      }
      if (cleanupErrors.length > 0) {
        throw aggregateWithCause(
          [error, ...cleanupErrors],
          "GOVERNOR_GATEWAY_STARTUP_CLEANUP_FAILED",
          error,
        );
      }
      throw error;
    }
  };

  const apply = (config: OpenClawConfig, secretSnapshot: GatewayBehaviorGovernorSecretSnapshot) => {
    const result = serial.then(() => applyUnsafe(config, secretSnapshot));
    serial = result.catch(() => {});
    return result;
  };

  const close = () => {
    const result = serial.then(closeUnsafe);
    serial = result.catch(() => {});
    return result;
  };

  const freeze = () => {
    const result = serial.then(freezeUnsafe);
    serial = result.catch(() => {});
    return result;
  };

  return Object.freeze({ apply, close, freeze });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
