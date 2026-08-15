import type { OpenClawConfig } from "./types.openclaw.js";

export const C07_REQUIRED_ARCHITECTURE_VERSION = 7;
export const C07_IMPLEMENTED_ARCHITECTURE_VERSION = 1;
export const C07_ARCHITECTURE_NOT_READY = "C07_ARCHITECTURE_NOT_READY";

export function isC07EnforceRequested(config: OpenClawConfig): boolean {
  const governor = config.experimental?.behaviorGovernor;
  return governor?.enabled === true && governor.mode === "enforce";
}

/** No implementation slice may activate C07 before the signed final readiness gate replaces this. */
export function assertC07ArchitectureReady(config: OpenClawConfig): void {
  if (isC07EnforceRequested(config)) {
    throw new Error(C07_ARCHITECTURE_NOT_READY);
  }
}

/** Defensive lower-boundary fence for callers that bypass Gateway config activation. */
export function assertC07MemoryBackendUnavailable(memoryBackend: unknown): void {
  if (memoryBackend !== undefined) {
    throw new Error(C07_ARCHITECTURE_NOT_READY);
  }
}
