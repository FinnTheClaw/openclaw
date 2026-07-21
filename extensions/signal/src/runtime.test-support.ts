// Signal test support owns cleanup for the process-global plugin runtime slot.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { clearRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});

export function clearSignalRuntimeForTest(): void {
  clearRuntime();
}
