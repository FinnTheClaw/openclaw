import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ignoreMissingPath, isMissingPathError } from "../../infra/errno.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import {
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";
import {
  discoverSkillCandidates,
  resolveSkillDiscoveryLimits,
} from "../loading/skill-root-discovery.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

type WorkshopLiveReadContext = {
  skillFile: string;
  namePattern: RegExp;
  listSkillFiles: (skillDir: string) => Promise<Omit<WorkshopSkillSummary, "name" | "description">>;
};

export type WorkshopSkillSummary = {
  name: string;
  description: string;
  updatedAtMs: number;
  sizeBytes: number;
  files: string[];
};

// Authoring, Undo and maintenance continue to use the flat layout.
export type WorkshopReadOptions = { flatOnly?: boolean };

async function* readGroupedWorkshopSkills(
  context: WorkshopLiveReadContext,
  config: OpenClawConfig,
  skillsRoot: string,
) {
  const limits = resolveSkillDiscoveryLimits(config);
  const { candidates } = discoverSkillCandidates({
    dir: skillsRoot,
    source: "openclaw-workshop",
    limits,
    allowedSymlinkTargetRealPaths: [],
    followSymlinks: false,
  });
  const rootDir = path.resolve(skillsRoot);
  const grouped = candidates.filter(({ skillDir }) => path.dirname(skillDir) !== rootDir);
  if (grouped.length === 0) {
    return;
  }
  const reader = await root(skillsRoot, { symlinks: "reject", hardlinks: "reject" });
  let accepted = 0;
  for (const { skillDir } of grouped) {
    if (accepted >= limits.maxSkillsLoadedPerSource) {
      return;
    }
    const relativeDir = path.relative(skillsRoot, skillDir);
    // Honor both the discovery byte budget and the ordinary Workshop manifest read cap.
    const read = await reader
      .read(path.join(relativeDir, context.skillFile), {
        maxBytes: Math.min(limits.maxSkillFileBytes, 1024 * 1024),
      })
      .catch((error: unknown) => {
        if (
          isMissingPathError(error) ||
          (error instanceof FsSafeError &&
            ["symlink", "hardlink", "not-file", "too-large"].includes(error.code))
        ) {
          return undefined;
        }
        throw error;
      });
    if (!read) {
      continue;
    }
    const content = read.buffer.toString("utf8");
    let metadata: ReturnType<typeof parseSkillFrontmatter>;
    try {
      metadata = parseSkillFrontmatter(content);
    } catch {
      continue;
    }
    const name = metadata.name?.trim() || path.basename(skillDir);
    const description = metadata.description?.trim();
    if (!context.namePattern.test(name) || !description) {
      continue;
    }
    accepted += 1;
    yield {
      name,
      description,
      content,
      relativeDir,
      skillDir: path.dirname(read.realPath),
      reader,
    };
  }
}

export async function listLiveWorkshopSkills(
  context: WorkshopLiveReadContext,
  config: OpenClawConfig,
  agentId: string,
  options?: WorkshopReadOptions,
): Promise<WorkshopSkillSummary[]> {
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  const entries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch((error: unknown) => ignoreMissingPath(error) ?? []);
  const skills: WorkshopSkillSummary[] = [];
  let hasGroupingDirectory = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!context.namePattern.test(entry.name)) {
      hasGroupingDirectory ||= !entry.name.startsWith(".") && entry.name !== "node_modules";
      continue;
    }
    const skillDir = path.join(skillsRoot, entry.name);
    const content = await readWorkspaceSkillFile(path.join(skillDir, context.skillFile));
    if (content === null) {
      hasGroupingDirectory = true;
      continue;
    }
    let description = "";
    try {
      description = parseSkillFrontmatter(content).description?.trim() ?? "";
    } catch {
      // A hand-edited skill with broken frontmatter still lists; view shows the file.
    }
    skills.push({ name: entry.name, description, ...(await context.listSkillFiles(skillDir)) });
  }
  if (!options?.flatOnly && hasGroupingDirectory) {
    const names = new Set(skills.map(({ name }) => name));
    for await (const group of readGroupedWorkshopSkills(context, config, skillsRoot)) {
      const { name, description, skillDir } = group;
      if (!names.has(name)) {
        names.add(name);
        skills.push({ name, description, ...(await context.listSkillFiles(skillDir)) });
      }
    }
  }
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function readGroupedWorkshopView(
  context: WorkshopLiveReadContext,
  config: OpenClawConfig,
  skillsRoot: string,
  name: string,
  file: string,
): Promise<{ files: string[]; content: string | null } | undefined> {
  for await (const group of readGroupedWorkshopSkills(context, config, skillsRoot)) {
    if (group.name !== name) {
      continue;
    }
    const { files } = await context.listSkillFiles(group.skillDir);
    const content =
      file === context.skillFile
        ? group.content
        : await group.reader
            .readText(path.join(group.relativeDir, file), {
              maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
            })
            .catch((error: unknown) => {
              if (isMissingPathError(error)) {
                return null;
              }
              throw error;
            });
    return { files, content };
  }
  return undefined;
}
