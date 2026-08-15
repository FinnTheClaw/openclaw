import { ensureSessionGoal } from "../../config/sessions/goals.js";
import type { PluginRuntimeGoals } from "./runtime-goal.types.js";

export function createRuntimeGoals(options: { storePath?: string } = {}): PluginRuntimeGoals {
  return {
    ensure: (params) => ensureSessionGoal({ ...params, storePath: options.storePath }),
  };
}
