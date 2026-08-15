export type FunctionalFinnConfig = {
  agentIds: readonly string[];
  channels: readonly string[];
  verifierSocketPath: string;
  verifierTimeoutMs: number;
};

function readStringSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  const entries = value.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (entries.length === 0 || entries.some((entry) => !entry)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return Object.freeze(entries);
}

export function readFunctionalFinnConfig(value: unknown): FunctionalFinnConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Functional Finn config must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) =>
      key !== "agentIds" &&
      key !== "channels" &&
      key !== "verifierSocketPath" &&
      key !== "verifierTimeoutMs",
  );
  if (unknown.length > 0) {
    throw new Error(`unknown Functional Finn config key: ${unknown[0]}`);
  }
  const verifierSocketPath =
    typeof record.verifierSocketPath === "string" ? record.verifierSocketPath.trim() : "";
  const verifierTimeoutMs = record.verifierTimeoutMs ?? 2_000;
  if (!verifierSocketPath) {
    throw new Error("verifierSocketPath must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(verifierTimeoutMs) ||
    (verifierTimeoutMs as number) < 100 ||
    (verifierTimeoutMs as number) > 5_000
  ) {
    throw new Error("verifierTimeoutMs must be between 100 and 5000");
  }
  return Object.freeze({
    agentIds: readStringSet(record.agentIds, "agentIds"),
    channels: readStringSet(record.channels, "channels"),
    verifierSocketPath,
    verifierTimeoutMs: verifierTimeoutMs as number,
  });
}
