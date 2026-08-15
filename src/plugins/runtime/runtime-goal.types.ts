import type { SessionGoal } from "../../config/sessions/types.js";

export type PluginRuntimeGoalEnsureParams = {
  sessionKey: string;
  objective: string;
  tokenBudget?: number;
};

export type PluginRuntimeGoalEnsureResult = {
  goal: SessionGoal;
  disposition: "created" | "reused" | "replaced_completed";
};

export type PluginRuntimeGoals = {
  ensure: (params: PluginRuntimeGoalEnsureParams) => Promise<PluginRuntimeGoalEnsureResult>;
};
