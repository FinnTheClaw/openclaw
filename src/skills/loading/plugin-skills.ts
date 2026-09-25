// Plugin skill loaders discover and normalize skills exposed by plugin packages.
import fs from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "../../plugins/config-policy.js";
import { resolveMemorySlotDecision } from "../../plugins/config-state.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  pluginCacheExistsSync,
  pluginCacheLstatSync,
  pluginCacheRealpathSync,
  readPluginCacheDirectory,
} from "../../plugins/plugin-cache-files.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { hasKind } from "../../plugins/slots.js";
import { isPathInside } from "../../security/scan-paths.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills");

type PluginSkillLinkType = "dir" | "junction";

export type PluginSkillRoot = {
  dir: string;
  rejectHardlinks: boolean;
};

// This tracks the generated SDK links we last published, not plugin metadata.
// Config and ACP availability can change the desired links without changing package files.
let lastDefaultPluginSkillsPublication: ReadonlyMap<string, string> | null = null;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  lastDefaultPluginSkillsPublication = null;
});

export function resolvePluginSkillRoots(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  /** Override the plugin skills directory for testing. */
  pluginSkillsDir?: string;
}): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    workspaceDir,
    config: params.config,
    env: process.env,
  });
  return resolvePluginSkillRootsFromMetadata({ ...params, metadataSnapshot });
}

export function resolvePluginSkillRootsFromMetadata(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  pluginSkillsDir?: string;
  metadataSnapshot: PluginMetadataSnapshot;
}): PluginSkillRoot[] {
  return withPluginCache(getPluginMetadataSnapshotCache(params.metadataSnapshot), () =>
    resolvePluginSkillRootsInOwner(params),
  );
}

function resolvePluginSkillRootsInOwner(
  params: Parameters<typeof resolvePluginSkillRootsFromMetadata>[0],
): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], { pluginSkillsDir: params.pluginSkillsDir });
    return [];
  }
  const config = params.config ?? {};
  const metadataSnapshot = params.metadataSnapshot;
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config });
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    config.plugins,
    metadataSnapshot.normalizePluginId,
  );
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: PluginSkillRoot[] = [];

  for (const record of registry.plugins) {
    if (!record.skills || record.skills.length === 0) {
      continue;
    }
    const activationState = resolvePolicyPluginActivationState({
      id: record.id,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedPlugins,
      rootConfig: config,
      enabledByDefault: record.enabledByDefault,
    });
    if (!activationState.activated) {
      continue;
    }
    // ACP router skills should not be attached unless ACP can actually spawn.
    if (!acpRuntimeAvailable && record.id === "acpx") {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      selectedMemoryPluginId = record.id;
    }
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
    });
    for (const raw of record.skills) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!pluginCacheExistsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPluginSkillPathInside(record.rootDir, candidate)) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      const candidates =
        record.bundleFormat === "agent" ? collectAgentSkillTargets(candidate) : [candidate];
      for (const resolvedCandidate of candidates) {
        if (seen.has(resolvedCandidate)) {
          continue;
        }
        seen.add(resolvedCandidate);
        resolved.push({ dir: resolvedCandidate, rejectHardlinks });
      }
    }
  }

  publishPluginSkills(
    resolved.map((root) => root.dir),
    {
      pluginSkillsDir: params.pluginSkillsDir,
    },
  );

  return resolved;
}

function isPluginSkillPathInside(rootDir: string, candidate: string): boolean {
  if (!isPathInside(rootDir, candidate)) {
    return false;
  }
  const rootRealPath = pluginCacheRealpathSync(rootDir);
  const candidateRealPath = pluginCacheRealpathSync(candidate);
  return Boolean(
    rootRealPath && candidateRealPath && isPathInside(rootRealPath, candidateRealPath),
  );
}

function listSkillChildDirectories(dir: string): Array<{ name: string; path: string }> {
  try {
    return readPluginCacheDirectory(dir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
  } catch {
    return [];
  }
}

function collectAgentSkillTargets(skillsRoot: string): string[] {
  const targets: string[] = [];
  for (const entry of listSkillChildDirectories(skillsRoot)) {
    if (hasPublishableSkillFile({ skillDir: entry.path, rootDir: skillsRoot })) {
      targets.push(entry.path);
      continue;
    }
    log.warn(`agent plugin skill skipped because SKILL.md is missing or invalid: ${entry.path}`);
  }
  return targets;
}

function resolveDefaultPluginSkillsDir(): string {
  return path.join(CONFIG_DIR, "plugin-skills");
}

function resolvePluginSkillLinkType(
  platform: NodeJS.Platform = process.platform,
): PluginSkillLinkType {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * Collect skill dir targets from a resolved directory.
 * If the directory contains a direct SKILL.md it is published as-is.
 * Otherwise child subdirectories that contain SKILL.md are expanded.
 */
function collectSkillTargets(dir: string, targets: Map<string, string>): void {
  if (hasPublishableSkillFile({ skillDir: dir, rootDir: dir })) {
    const basename = path.basename(dir);
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${dir}; ` +
          `only the first will be published`,
      );
      return;
    }
    targets.set(basename, dir);
    return;
  }

  for (const entry of listSkillChildDirectories(dir)) {
    const childPath = entry.path;
    if (!hasPublishableSkillFile({ skillDir: childPath, rootDir: dir })) {
      continue;
    }
    const basename = entry.name;
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${childPath}; ` +
          `only the first will be published`,
      );
      continue;
    }
    targets.set(basename, childPath);
  }
}

function hasPublishableSkillFile(params: { skillDir: string; rootDir: string }): boolean {
  const skillMd = path.join(params.skillDir, "SKILL.md");
  const skillMdStat = pluginCacheLstatSync(skillMd);
  if (!skillMdStat) {
    return false;
  }
  if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
    log.warn(`plugin skill SKILL.md is not a regular file: ${skillMd}`);
    return false;
  }
  if (!isPluginSkillPathInside(params.rootDir, skillMd)) {
    log.warn(`plugin skill SKILL.md escapes declared skill root: ${skillMd}`);
    return false;
  }
  return true;
}

/**
 * Creates symlinks from each resolved plugin skill directory into the
 * plugin skills directory (~/.openclaw/plugin-skills/) so the agent SDK can
 * discover them at the conventional file-system path.
 *
 * OpenClaw publishes generated links here. Unexpected ordinary files and
 * directories are preserved, even when they share a managed skill name.
 */
function publishPluginSkills(skillDirs: string[], opts?: { pluginSkillsDir?: string }): void {
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolveDefaultPluginSkillsDir();
  const managedTargets = new Map<string, string>();

  // Collect basename → target mappings, reporting collisions.
  // Directories that contain SKILL.md are published as-is.
  // Parent containers (e.g. ./skills/) are expanded to their child
  // directories that each contain a SKILL.md.
  for (const dir of skillDirs) {
    collectSkillTargets(dir, managedTargets);
  }

  if (
    opts?.pluginSkillsDir === undefined &&
    lastDefaultPluginSkillsPublication?.size === managedTargets.size &&
    [...managedTargets].every(
      ([name, target]) => lastDefaultPluginSkillsPublication?.get(name) === target,
    )
  ) {
    return;
  }

  // Plugin skill symlinks are owned by OpenClaw and publish at extra-dir
  // precedence, so they never shadow managed or bundled skills.
  for (const [name, target] of managedTargets) {
    const linkPath = path.join(pluginSkillsDir, name);
    try {
      fs.mkdirSync(pluginSkillsDir, { recursive: true });
    } catch {
      // best-effort; symlink will fail below if dir is truly unusable
    }
    try {
      const existingEntry = fs.lstatSync(linkPath);
      if (existingEntry.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(linkPath);
        if (existingTarget === target) {
          continue;
        }
        if (!removeGeneratedPluginSkillEntry(linkPath)) {
          continue;
        }
      } else if (isGeneratedPluginSkillEntry(existingEntry, linkPath)) {
        if (!removeGeneratedPluginSkillEntry(linkPath)) {
          continue;
        }
      } else {
        log.warn(`plugin skill entry is not a generated symlink: ${linkPath}`);
        continue;
      }
    } catch (err) {
      if (!isMissingPathError(err)) {
        log.warn(`failed to inspect plugin skill symlink "${linkPath}": ${String(err)}`);
        continue;
      }
    }
    try {
      fs.symlinkSync(target, linkPath, resolvePluginSkillLinkType());
    } catch (err) {
      log.warn(`failed to create plugin skill symlink "${linkPath}" → "${target}": ${String(err)}`);
    }
  }

  // Clean up stale generated links for plugin skills that are no longer active.
  // Preserve any ordinary file or directory that appears in this location.
  let existingEntries: fs.Dirent[];
  try {
    existingEntries = fs.readdirSync(pluginSkillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of existingEntries) {
    const linkPath = path.join(pluginSkillsDir, entry.name);
    if (!isGeneratedPluginSkillEntry(entry, linkPath)) {
      continue;
    }
    if (managedTargets.has(entry.name)) {
      continue;
    }
    removeGeneratedPluginSkillEntry(linkPath);
  }
  if (opts?.pluginSkillsDir === undefined) {
    lastDefaultPluginSkillsPublication = managedTargets;
  }
}

function isGeneratedPluginSkillEntry(
  entry: Pick<fs.Dirent, "isDirectory" | "isSymbolicLink">,
  linkPath: string,
): boolean {
  if (entry.isSymbolicLink()) {
    return true;
  }
  if (process.platform !== "win32" || !entry.isDirectory()) {
    return false;
  }
  // Some Windows junctions appear as directories. A successful readlink is
  // positive link proof; an ordinary directory must never be treated as generated.
  try {
    fs.readlinkSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

function removeGeneratedPluginSkillEntry(linkPath: string): boolean {
  try {
    const entry = fs.lstatSync(linkPath);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      return true;
    }
    if (isGeneratedPluginSkillEntry(entry, linkPath)) {
      // rmdir removes a proven junction itself without recursive target traversal.
      fs.rmdirSync(linkPath);
      return true;
    }
  } catch (err) {
    if (isMissingPathError(err)) {
      return true;
    }
    log.warn(`failed to remove plugin skill symlink "${linkPath}": ${String(err)}`);
  }
  return false;
}
