import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";

export async function requestConfigRestartAcceptance(params: {
  plan: GatewayReloadPlan;
  nextConfig: OpenClawConfig;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  logError: (message: string) => void;
}): Promise<boolean> {
  try {
    // The callback accepts only after non-activating candidate preflight, then
    // returns after scheduling any deferred or immediate restart.
    await params.onRestart(params.plan, params.nextConfig);
    return true;
  } catch (error) {
    params.logError(`config restart failed: ${String(error)}`);
    return false;
  }
}
