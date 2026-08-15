// Signal plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { configureFunctionalFinnSignalReleaseStore } from "./functional-finn-release-store.js";

const {
  setRuntime,
  getRuntime: getSignalRuntime,
  tryGetRuntime: getOptionalSignalRuntime,
  clearRuntime: clearSignalRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});
function setSignalRuntime(runtime: PluginRuntime): void {
  setRuntime(runtime);
  configureFunctionalFinnSignalReleaseStore(runtime);
}
export { clearSignalRuntime, getOptionalSignalRuntime, getSignalRuntime, setSignalRuntime };
