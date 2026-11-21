/**
 * Overlays per-agent loop detection settings on global tool defaults while
 * preserving the per-agent enabled override.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

export function resolveToolLoopDetectionConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection;
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined;

  // Our frozen distribution enables the native guard unless explicitly opted out.
  // Keep per-agent choices authoritative over the global setting.
  return { enabled: agent?.enabled ?? global?.enabled ?? true };
}
