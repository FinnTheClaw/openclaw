import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyCommunicationIdentityConfig } from "./communication-identity-policy.js";
import {
  COMMUNICATION_IDENTITY_REGISTRY_FILE,
  COMMUNICATION_QUARANTINE_AGENT_ID,
  isCommunicationIdentityRegistry,
  type CommunicationIdentityRegistry,
} from "./communication-identity-registry.js";

const MANAGED_BINDING_PREFIX = "communication-identity:";

function containsManagedIdentityProjection(config: OpenClawConfig): boolean {
  return Boolean(
    config.agents?.list?.some((agent) => agent.id === COMMUNICATION_QUARANTINE_AGENT_ID) ||
    config.bindings?.some(
      (binding) =>
        binding.type === "route" &&
        typeof binding.comment === "string" &&
        binding.comment.startsWith(MANAGED_BINDING_PREFIX),
    ),
  );
}

function assertPrivateOwner(stat: fs.Stats, label: string): void {
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the OpenClaw runtime user.`);
  }
}

function readProtectedRegistry(filePath: string): CommunicationIdentityRegistry {
  const directory = path.dirname(filePath);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Communication identity registry directory must be a regular directory.");
  }
  assertPrivateOwner(directoryStat, "Communication identity registry directory");

  const fileStat = fs.lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Communication identity registry must be a regular file.");
  }
  assertPrivateOwner(fileStat, "Communication identity registry");

  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isCommunicationIdentityRegistry(parsed)) {
    throw new Error(`Invalid communication identity registry: ${filePath}`);
  }
  return parsed;
}

/**
 * Reapply the protected identity projection to every loaded runtime config.
 * This makes managed privilege boundaries resilient to stale config files and
 * accidental GUI edits. A durable pending transaction wins until reconciled.
 */
export function applyCommunicationIdentityRuntimeOverlay(params: {
  config: OpenClawConfig;
  stateDir: string;
}): OpenClawConfig {
  const registryPath = path.join(
    path.resolve(params.stateDir),
    "identity",
    COMMUNICATION_IDENTITY_REGISTRY_FILE,
  );
  const pendingPath = `${registryPath}.pending`;
  const hasRegistry = fs.existsSync(registryPath);
  const hasPending = fs.existsSync(pendingPath);
  if (!hasRegistry && !hasPending) {
    if (containsManagedIdentityProjection(params.config)) {
      throw new Error(
        "Communication identity policy is configured but its protected registry is missing.",
      );
    }
    return params.config;
  }
  if (!hasRegistry) {
    throw new Error("Communication identity transaction exists without its canonical registry.");
  }

  const registry = readProtectedRegistry(hasPending ? pendingPath : registryPath);
  return applyCommunicationIdentityConfig({
    config: params.config,
    registry,
    stateDir: path.resolve(params.stateDir),
  });
}
