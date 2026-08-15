import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const FUNCTIONAL_FINN_PROJECTION_FILE = "functional-finn-verified.md";
export const FUNCTIONAL_FINN_LEGACY_PROJECTION = path.join("verified", "functional-finn.md");

export type FunctionalFinnProjectionPaths = {
  workspaceDir: string;
  memoryDir: string;
  target: string;
  legacyTarget: string;
  ownerHeader: string;
};

export type FunctionalFinnProjectionPathFileSystem = {
  lstat: (target: string) => Promise<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  readFile: (target: string, encoding: "utf8") => Promise<string>;
  rm: (target: string, options: { force: true }) => Promise<unknown>;
  rmdir: (target: string) => Promise<unknown>;
};

function agentDigest(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 32);
}

export function resolveFunctionalFinnProjectionPaths(params: {
  workspaceDir: string;
  agentId: string;
}): FunctionalFinnProjectionPaths {
  if (!params.workspaceDir.trim() || !path.isAbsolute(params.workspaceDir)) {
    throw new Error("Functional Finn requires an absolute agent workspace path");
  }
  const workspaceDir = path.resolve(params.workspaceDir);
  const memoryDir = path.join(workspaceDir, "memory");
  const target = path.join(memoryDir, FUNCTIONAL_FINN_PROJECTION_FILE);
  const legacyTarget = path.join(memoryDir, FUNCTIONAL_FINN_LEGACY_PROJECTION);
  if (
    path.dirname(target) !== memoryDir ||
    path.relative(workspaceDir, target).startsWith("..") ||
    path.isAbsolute(path.relative(workspaceDir, target))
  ) {
    throw new Error("Functional Finn projection path escaped the agent workspace");
  }
  return {
    workspaceDir,
    memoryDir,
    target,
    legacyTarget,
    ownerHeader: `<!-- functional-finn:projection-owner:v1; agentDigest=${agentDigest(params.agentId)} -->`,
  };
}

export function createFunctionalFinnProjectionPathRegistry(params: {
  agentIds: readonly string[];
  workspaceForAgent: (agentId: string) => string;
  caseInsensitive?: boolean;
}): ReadonlyMap<string, FunctionalFinnProjectionPaths> {
  const paths = new Map<string, FunctionalFinnProjectionPaths>();
  const owners = new Map<string, string>();
  const caseInsensitive = params.caseInsensitive ?? process.platform === "darwin";
  for (const agentId of params.agentIds) {
    const resolved = resolveFunctionalFinnProjectionPaths({
      agentId,
      workspaceDir: params.workspaceForAgent(agentId),
    });
    const ownerKey = (
      caseInsensitive ? resolved.target.toLocaleLowerCase("en-US") : resolved.target
    ).normalize("NFC");
    const existing = owners.get(ownerKey);
    if (existing && existing !== agentId) {
      throw new Error(
        `Functional Finn projection path is shared by agents ${existing} and ${agentId}`,
      );
    }
    owners.set(ownerKey, agentId);
    paths.set(agentId, resolved);
  }
  return paths;
}

async function lstatIfPresent(fileSystem: FunctionalFinnProjectionPathFileSystem, target: string) {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isOwnedLegacyProjection(content: string): boolean {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "# Verified memory" || lines[1] !== "") {
    return false;
  }
  return lines
    .slice(2)
    .every(
      (line) =>
        line === "" ||
        /^- .* <!-- functional-finn:[a-f0-9]{64}; observedAt=\d+; freshnessUntil=\d+ -->$/.test(
          line,
        ),
    );
}

export async function inspectFunctionalFinnProjectionOwnership(params: {
  paths: FunctionalFinnProjectionPaths;
  fileSystem?: FunctionalFinnProjectionPathFileSystem;
}): Promise<{ canonicalPresent: boolean; legacyPresent: boolean }> {
  const fileSystem = params.fileSystem ?? fs;
  const memoryStat = await lstatIfPresent(fileSystem, params.paths.memoryDir);
  if (memoryStat && (!memoryStat.isDirectory() || memoryStat.isSymbolicLink())) {
    throw new Error("Functional Finn memory directory is not an owned real directory");
  }

  const targetStat = await lstatIfPresent(fileSystem, params.paths.target);
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("Functional Finn canonical projection is not an owned real file");
    }
    const content = await fileSystem.readFile(params.paths.target, "utf8");
    if (!content.startsWith(`${params.paths.ownerHeader}\n`)) {
      throw new Error("Functional Finn canonical projection ownership is ambiguous");
    }
  }

  const legacyStat = await lstatIfPresent(fileSystem, params.paths.legacyTarget);
  if (!legacyStat) {
    return { canonicalPresent: targetStat !== undefined, legacyPresent: false };
  }
  if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) {
    throw new Error("Functional Finn legacy projection ownership is ambiguous");
  }
  const legacyContent = await fileSystem.readFile(params.paths.legacyTarget, "utf8");
  if (!isOwnedLegacyProjection(legacyContent)) {
    throw new Error("Functional Finn legacy projection ownership is ambiguous");
  }
  return { canonicalPresent: targetStat !== undefined, legacyPresent: true };
}

export async function retireFunctionalFinnLegacyProjection(params: {
  paths: FunctionalFinnProjectionPaths;
  fileSystem?: FunctionalFinnProjectionPathFileSystem;
}): Promise<void> {
  const fileSystem = params.fileSystem ?? fs;
  await fileSystem.rm(params.paths.legacyTarget, { force: true });
  await fileSystem.rmdir(path.dirname(params.paths.legacyTarget)).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  });
}
