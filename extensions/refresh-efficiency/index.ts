import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { C02_EFFICIENCY_GUIDANCE, isC02GuidanceEnabled } from "./guidance.js";
import { registerC02Telemetry } from "./telemetry.js";

const PLUGIN_ID = "refresh-efficiency";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Refresh Efficiency",
  description: "Proportionate prompt guidance and observational efficiency metrics.",
  register(api) {
    registerC02Telemetry(api);
    api.on("before_prompt_build", () => {
      const config = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        PLUGIN_ID,
        api.pluginConfig as Record<string, unknown>,
      );
      return isC02GuidanceEnabled(config)
        ? { prependSystemContext: C02_EFFICIENCY_GUIDANCE }
        : undefined;
    });
  },
});
