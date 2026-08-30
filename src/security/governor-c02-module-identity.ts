import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "./governor-c02-simple-efficiency-policy.js";

export function isExactGovernorC02Module(config: GovernorAgentLoopConfiguration): boolean {
  return (
    config.moduleIdentity?.id === C02_SIMPLE_EFFICIENCY_ID &&
    config.moduleIdentity.version === C02_SIMPLE_EFFICIENCY_VERSION
  );
}
