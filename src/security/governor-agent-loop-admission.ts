import type { GovernorAgentLoopMode } from "./governor-agent-loop-config.js";

const FROZEN_HOSTS = new WeakSet<object>();

export function freezeGovernorAgentLoopHostAdmission(host: object): void {
  FROZEN_HOSTS.add(host);
}

export function createGovernorAgentLoopHostFreeze(getHost: () => object | undefined): () => void {
  return () => {
    const host = getHost();
    if (host) {
      freezeGovernorAgentLoopHostAdmission(host);
    }
  };
}

export function assertGovernorAgentLoopAdmission(
  host: object,
  mode: GovernorAgentLoopMode,
): boolean {
  if (!FROZEN_HOSTS.has(host)) {
    return true;
  }
  if (mode === "shadow") {
    return false;
  }
  throw new Error("GOVERNOR_HOST_ADMISSION_FROZEN");
}
