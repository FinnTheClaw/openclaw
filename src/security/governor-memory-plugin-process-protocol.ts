export const C07_PLUGIN_PROCESS_PROTOCOL_VERSION = 1;
export const C07_PLUGIN_PROCESS_MAX_FRAME_BYTES = 256 * 1024;

export type C07PluginJson =
  | null
  | boolean
  | number
  | string
  | readonly C07PluginJson[]
  | { readonly [key: string]: C07PluginJson };

export type C07PluginHostFrame =
  | Readonly<{
      type: "invoke";
      version: 1;
      bootEpoch: string;
      requestId: string;
      sequence: number;
      payload: C07PluginJson;
    }>
  | Readonly<{ type: "close"; version: 1; bootEpoch: string; sequence: number }>;

export type C07PluginWorkerFrame =
  | Readonly<{
      type: "ready";
      version: 1;
      bootEpoch: string;
      pid: number;
      uid: number;
      gid: number;
      groups: readonly number[];
      implementationDigest: string;
    }>
  | Readonly<{
      type: "result";
      version: 1;
      bootEpoch: string;
      requestId: string;
      sequence: number;
      ok: boolean;
      payload?: C07PluginJson;
      errorCode?: "PLUGIN_INVOCATION_FAILED" | "PLUGIN_RESULT_INVALID";
    }>
  | Readonly<{
      type: "fatal";
      version: 1;
      bootEpoch: string;
      errorCode: "PLUGIN_BOOT_INVALID" | "PLUGIN_PROTOCOL_INVALID";
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isJson(value: unknown, depth = 0): value is C07PluginJson {
  if (depth > 32) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJson(entry, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.keys(value).length <= 256 &&
    Object.values(value).every((entry) => isJson(entry, depth + 1))
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0");
}

export function assertC07PluginFrameSize(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  if (encoded === undefined) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  if (Buffer.byteLength(encoded, "utf8") > C07_PLUGIN_PROCESS_MAX_FRAME_BYTES) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_TOO_LARGE");
  }
}

export function parseC07PluginHostFrame(value: unknown): C07PluginHostFrame {
  assertC07PluginFrameSize(value);
  if (!isRecord(value) || value.version !== C07_PLUGIN_PROCESS_PROTOCOL_VERSION) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  if (value.type === "invoke") {
    if (
      !hasExactKeys(value, ["type", "version", "bootEpoch", "requestId", "sequence", "payload"]) ||
      !isDigest(value.bootEpoch) ||
      !isDigest(value.requestId) ||
      !isPositiveInteger(value.sequence) ||
      !isJson(value.payload)
    ) {
      throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
    }
    return value as C07PluginHostFrame;
  }
  if (
    value.type !== "close" ||
    !hasExactKeys(value, ["type", "version", "bootEpoch", "sequence"]) ||
    !isDigest(value.bootEpoch) ||
    !isPositiveInteger(value.sequence)
  ) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  return value as C07PluginHostFrame;
}

export function parseC07PluginWorkerFrame(value: unknown): C07PluginWorkerFrame {
  assertC07PluginFrameSize(value);
  if (!isRecord(value) || value.version !== C07_PLUGIN_PROCESS_PROTOCOL_VERSION) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  if (value.type === "ready") {
    if (
      !hasExactKeys(value, [
        "type",
        "version",
        "bootEpoch",
        "pid",
        "uid",
        "gid",
        "groups",
        "implementationDigest",
      ]) ||
      !isDigest(value.bootEpoch) ||
      !isPositiveInteger(value.pid) ||
      !Number.isSafeInteger(value.uid) ||
      !Number.isSafeInteger(value.gid) ||
      !Array.isArray(value.groups) ||
      value.groups.length === 0 ||
      !value.groups.every((group) => Number.isSafeInteger(group) && Number(group) >= 0) ||
      !isDigest(value.implementationDigest)
    ) {
      throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
    }
    return value as C07PluginWorkerFrame;
  }
  if (value.type === "fatal") {
    if (
      !hasExactKeys(value, ["type", "version", "bootEpoch", "errorCode"]) ||
      !isDigest(value.bootEpoch) ||
      (value.errorCode !== "PLUGIN_BOOT_INVALID" && value.errorCode !== "PLUGIN_PROTOCOL_INVALID")
    ) {
      throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
    }
    return value as C07PluginWorkerFrame;
  }
  const optionalKey = value.ok === true ? "payload" : "errorCode";
  if (
    value.type !== "result" ||
    !hasExactKeys(value, [
      "type",
      "version",
      "bootEpoch",
      "requestId",
      "sequence",
      "ok",
      optionalKey,
    ]) ||
    !isDigest(value.bootEpoch) ||
    !isDigest(value.requestId) ||
    !isPositiveInteger(value.sequence) ||
    typeof value.ok !== "boolean" ||
    (value.ok
      ? !isJson(value.payload)
      : value.errorCode !== "PLUGIN_INVOCATION_FAILED" &&
        value.errorCode !== "PLUGIN_RESULT_INVALID")
  ) {
    throw new Error("C07_PLUGIN_PROCESS_FRAME_INVALID");
  }
  return value as C07PluginWorkerFrame;
}
