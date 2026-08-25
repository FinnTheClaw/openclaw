import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";

const SKILLS_INVALIDATION_PREFIXES = ["skills"] as const;

function matchesSkillsInvalidationPrefix(path: string): boolean {
  return SKILLS_INVALIDATION_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

/** Invalidate persisted session tool snapshots after a skills config change. */
export function invalidateSkillsSnapshotForConfigChanges(params: {
  changedPaths: string[];
  logInfo: (message: string) => void;
}): void {
  const changedPath = params.changedPaths.find(matchesSkillsInvalidationPrefix);
  if (changedPath === undefined) {
    return;
  }
  bumpSkillsSnapshotVersion({ reason: "config-change", changedPath });
  params.logInfo(`skills snapshot invalidated by config change (${changedPath})`);
}
