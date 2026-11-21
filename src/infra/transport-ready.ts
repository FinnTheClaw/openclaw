// Compatibility owner for frozen callers; readiness logic lives in the current SDK owner.
export { waitForTransportReady } from "../plugin-sdk/transport-ready-runtime.js";
export type { WaitForTransportReadyParams } from "../plugin-sdk/transport-ready-runtime.js";
export type TransportReadyResult = { ok: boolean; error?: string | null };
