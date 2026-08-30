import type { StreamFn } from "./runtime/index.js";

const builtInProviderTransports = new WeakSet<StreamFn>();

/** Records a host-constructed transport before any session or provider wrapper can replace it. */
export function markBuiltInProviderTransport(streamFn: StreamFn): StreamFn {
  builtInProviderTransports.add(streamFn);
  return streamFn;
}

/** Function identity is the capability; model fields alone never qualify a transport. */
export function isBuiltInProviderTransport(streamFn: StreamFn | undefined): boolean {
  return streamFn !== undefined && builtInProviderTransports.has(streamFn);
}
