/**
 * Durable communication-identity isolation runtime.
 *
 * Pairing projects a protected identity registry into exact routes, isolated
 * agents, workspaces, sessions, memory namespaces, and fail-closed sandboxes
 * before a sender is admitted to a channel allow-list.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { getRuntimeConfig, mutateConfigFileWithRetry } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { applyCommunicationIdentityConfig } from "./communication-identity-policy.js";
import {
  COMMUNICATION_IDENTITY_LOCK_OPTIONS,
  COMMUNICATION_IDENTITY_REGISTRY_FILE,
  communicationIdentityMemberPaths,
  createCommunicationIdentityRegistry,
  isCommunicationIdentityRegistry,
  normalizeCommunicationPhone,
  planCommunicationAdminTransfer,
  planCommunicationIdentityApproval,
  seedCommunicationIdentityRegistryFromConfigOwners,
  type CommunicationIdentity,
  type CommunicationIdentityRegistry,
  type EnsuredCommunicationIdentity,
} from "./communication-identity-registry.js";

export {
  createCommunicationIdentityRegistryForTest,
  normalizeCommunicationPhone,
  planCommunicationAdminTransfer,
  planCommunicationIdentityApproval,
  seedCommunicationIdentityRegistryFromConfigOwners,
} from "./communication-identity-registry.js";
export type {
  CommunicationIdentity,
  CommunicationIdentityEndpoint,
  CommunicationIdentityRegistry,
  EnsuredCommunicationIdentity,
  PlannedCommunicationAdminTransfer,
  PlannedCommunicationIdentity,
} from "./communication-identity-registry.js";
export { applyCommunicationIdentityConfig } from "./communication-identity-policy.js";

export function resolveCommunicationIdentityRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "identity", COMMUNICATION_IDENTITY_REGISTRY_FILE);
}

async function ensureRegistryFile(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.promises.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Communication identity registry directory must not be a symlink.");
  }
  await fs.promises.chmod(directory, 0o700);
  try {
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify(createCommunicationIdentityRegistry(), null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Communication identity registry must be a regular, non-symlink file.");
  }
  await fs.promises.chmod(filePath, 0o600);
}

async function readRegistry(filePath: string): Promise<CommunicationIdentityRegistry> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Communication identity registry is not a regular file: ${filePath}`);
  }
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isCommunicationIdentityRegistry(parsed)) {
    throw new Error(`Invalid communication identity registry: ${filePath}`);
  }
  return parsed;
}

async function writeRegistry(
  filePath: string,
  registry: CommunicationIdentityRegistry,
): Promise<void> {
  if (!isCommunicationIdentityRegistry(registry)) {
    throw new Error("Refusing to persist an invalid communication identity registry.");
  }
  await writeJsonFileAtomically(filePath, registry);
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Communication identity registry atomic write produced an unsafe path.");
  }
  await fs.promises.chmod(filePath, 0o600);
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Communication identity path escaped its protected state root.");
  }
}

async function ensureNonSymlinkDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Protected communication identity path is not a regular directory: ${directory}`,
    );
  }
  await fs.promises.chmod(directory, 0o700);
}

async function ensureIdentityRoot(stateDir: string): Promise<string> {
  const stateRoot = path.resolve(stateDir);
  await fs.promises.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const identityRoot = path.join(stateRoot, "communication-identities");
  assertPathInside(stateRoot, identityRoot);
  await ensureNonSymlinkDirectory(identityRoot);
  return identityRoot;
}

async function ensureIdentityWorkspace(
  identity: CommunicationIdentity,
  stateDir: string,
): Promise<void> {
  const identityRoot = await ensureIdentityRoot(stateDir);
  const expected = communicationIdentityMemberPaths(stateDir, identity.id);
  if (
    path.resolve(identity.workspace) !== expected.workspace ||
    path.resolve(identity.agentDir) !== expected.agentDir
  ) {
    throw new Error(
      `Communication identity ${identity.id} contains non-canonical workspace paths.`,
    );
  }
  const identityDirectory = path.dirname(expected.workspace);
  assertPathInside(identityRoot, identityDirectory);
  await ensureNonSymlinkDirectory(identityDirectory);
  await ensureNonSymlinkDirectory(identity.agentDir);
  await ensureAgentWorkspace({ dir: identity.workspace, ensureBootstrapFiles: true });
  await ensureNonSymlinkDirectory(identity.workspace);
  const boundaryDirectory = path.join(identity.workspace, ".openclaw");
  const boundaryPath = path.join(boundaryDirectory, "identity-boundary.json");
  assertPathInside(identity.workspace, boundaryPath);
  await ensureNonSymlinkDirectory(boundaryDirectory);
  try {
    await fs.promises.writeFile(
      boundaryPath,
      `${JSON.stringify({ version: 1, identityId: identity.id, memberAgentId: identity.memberAgentId }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const boundaryStat = await fs.promises.lstat(boundaryPath);
  if (!boundaryStat.isFile() || boundaryStat.isSymbolicLink()) {
    throw new Error("Communication identity boundary marker must be a regular file.");
  }
  await fs.promises.chmod(boundaryPath, 0o600);
}

async function ensureQuarantineWorkspace(stateDir: string): Promise<void> {
  const paths = communicationIdentityMemberPaths(stateDir, "quarantine");
  const identityRoot = await ensureIdentityRoot(stateDir);
  const quarantineRoot = path.dirname(paths.workspace);
  assertPathInside(identityRoot, quarantineRoot);
  await ensureNonSymlinkDirectory(quarantineRoot);
  await ensureNonSymlinkDirectory(paths.agentDir);
  await ensureAgentWorkspace({ dir: paths.workspace, ensureBootstrapFiles: false });
  await ensureNonSymlinkDirectory(paths.workspace);
}

async function projectRegistryToConfig(params: {
  registry: CommunicationIdentityRegistry;
  stateDir: string;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    maxAttempts: 5,
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const projected = applyCommunicationIdentityConfig({
        config: draft,
        registry: params.registry,
        stateDir: params.stateDir,
      });
      const mutableDraft = draft as unknown as Record<string, unknown>;
      for (const key of Object.keys(mutableDraft)) {
        delete mutableDraft[key];
      }
      Object.assign(draft, projected);
    },
  });
}

function pendingRegistryPath(registryPath: string): string {
  return `${registryPath}.pending`;
}

async function applyRegistryProjection(params: {
  registry: CommunicationIdentityRegistry;
  registryPath: string;
  stateDir: string;
}): Promise<void> {
  for (const identity of Object.values(params.registry.identities)) {
    await ensureIdentityWorkspace(identity, params.stateDir);
  }
  await ensureQuarantineWorkspace(params.stateDir);
  await projectRegistryToConfig({ registry: params.registry, stateDir: params.stateDir });
  await writeRegistry(params.registryPath, params.registry);
  await fs.promises.rm(pendingRegistryPath(params.registryPath), { force: true });
}

async function commitRegistryProjection(params: {
  registry: CommunicationIdentityRegistry;
  registryPath: string;
  stateDir: string;
}): Promise<void> {
  // This recovery pointer is durable before any config mutation. Pairing does
  // not allowlist the sender until the complete projection succeeds.
  await writeRegistry(pendingRegistryPath(params.registryPath), params.registry);
  await applyRegistryProjection(params);
}

async function recoverPendingRegistryProjection(params: {
  registryPath: string;
  stateDir: string;
}): Promise<CommunicationIdentityRegistry> {
  let pending: CommunicationIdentityRegistry;
  try {
    pending = await readRegistry(pendingRegistryPath(params.registryPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return await readRegistry(params.registryPath);
    }
    throw error;
  }
  await applyRegistryProjection({
    registry: pending,
    registryPath: params.registryPath,
    stateDir: params.stateDir,
  });
  return pending;
}

export async function ensureCommunicationIdentityForPairing(params: {
  channel: string;
  accountId?: string | null;
  peerId: string;
  identityPhone?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<EnsuredCommunicationIdentity> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const registryPath = resolveCommunicationIdentityRegistryPath(env);
  await ensureRegistryFile(registryPath);
  return await withFileLock(registryPath, COMMUNICATION_IDENTITY_LOCK_OPTIONS, async () => {
    const current = seedCommunicationIdentityRegistryFromConfigOwners({
      registry: await recoverPendingRegistryProjection({ registryPath, stateDir }),
      config: getRuntimeConfig(),
      stateDir,
    });
    const planned = planCommunicationIdentityApproval({
      registry: current,
      stateDir,
      channel: params.channel,
      accountId: params.accountId,
      peerId: params.peerId,
      identityPhone: params.identityPhone,
    });
    await commitRegistryProjection({ registry: planned.registry, registryPath, stateDir });
    const { registry: _registry, ...result } = planned;
    return result;
  });
}

export async function listCommunicationIdentities(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ adminIdentityId: string | null; identities: CommunicationIdentity[] }> {
  const stateDir = resolveStateDir(env);
  const registryPath = resolveCommunicationIdentityRegistryPath(env);
  await ensureRegistryFile(registryPath);
  return await withFileLock(registryPath, COMMUNICATION_IDENTITY_LOCK_OPTIONS, async () => {
    const registry = await recoverPendingRegistryProjection({ registryPath, stateDir });
    return {
      adminIdentityId: registry.adminIdentityId,
      identities: Object.values(registry.identities).toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
  });
}

export async function reconcileCommunicationIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommunicationIdentityRegistry> {
  const stateDir = resolveStateDir(env);
  const registryPath = resolveCommunicationIdentityRegistryPath(env);
  await ensureRegistryFile(registryPath);
  return await withFileLock(registryPath, COMMUNICATION_IDENTITY_LOCK_OPTIONS, async () => {
    const registry = seedCommunicationIdentityRegistryFromConfigOwners({
      registry: await recoverPendingRegistryProjection({ registryPath, stateDir }),
      config: getRuntimeConfig(),
      stateDir,
    });
    await commitRegistryProjection({ registry, registryPath, stateDir });
    return registry;
  });
}

export async function setCommunicationAdminPhone(params: {
  phone: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommunicationIdentity> {
  const env = params.env ?? process.env;
  const phone = normalizeCommunicationPhone(params.phone);
  if (!phone) {
    throw new Error("Admin phone must be a valid E.164 number.");
  }
  const stateDir = resolveStateDir(env);
  const registryPath = resolveCommunicationIdentityRegistryPath(env);
  await ensureRegistryFile(registryPath);
  return await withFileLock(registryPath, COMMUNICATION_IDENTITY_LOCK_OPTIONS, async () => {
    const current = await recoverPendingRegistryProjection({ registryPath, stateDir });
    const planned = planCommunicationAdminTransfer({ registry: current, stateDir, phone });
    await commitRegistryProjection({ registry: planned.registry, registryPath, stateDir });
    return planned.identity;
  });
}
