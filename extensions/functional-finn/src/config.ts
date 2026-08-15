export type FunctionalFinnConfig = {
  agentIds: readonly string[];
  channels: readonly string[];
  semanticSupportSocketPath: string;
  semanticSupportTimeoutMs: number;
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
      key !== "semanticSupportSocketPath" &&
      key !== "semanticSupportTimeoutMs",
  );
  if (unknown.length > 0) {
    throw new Error(`unknown Functional Finn config key: ${unknown[0]}`);
  }
  const semanticSupportSocketPath =
    typeof record.semanticSupportSocketPath === "string"
      ? record.semanticSupportSocketPath.trim()
      : "";
  const semanticSupportTimeoutMs = record.semanticSupportTimeoutMs ?? 2_000;
  if (!semanticSupportSocketPath) {
    throw new Error("semanticSupportSocketPath must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(semanticSupportTimeoutMs) ||
    (semanticSupportTimeoutMs as number) < 100 ||
    (semanticSupportTimeoutMs as number) > 5_000
  ) {
    throw new Error("semanticSupportTimeoutMs must be between 100 and 5000");
  }
  return Object.freeze({
    agentIds: readStringSet(record.agentIds, "agentIds"),
    channels: readStringSet(record.channels, "channels"),
    semanticSupportSocketPath,
    semanticSupportTimeoutMs: semanticSupportTimeoutMs as number,
  });
}
