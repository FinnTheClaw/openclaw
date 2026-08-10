// Keeps the behavior governor inert until an explicit rollout enables it.
export const BEHAVIOR_GOVERNOR_ENV = "OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR";

export function isBehaviorGovernorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BEHAVIOR_GOVERNOR_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
