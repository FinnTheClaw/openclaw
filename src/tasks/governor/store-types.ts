import type { GovernorTaskProjection } from "./types.js";

export type GovernorCommitResult =
  | { applied: true; task: GovernorTaskProjection }
  | {
      applied: false;
      reason: "not_found" | "task_version_conflict" | "lease_epoch_conflict";
      current?: GovernorTaskProjection;
    };
