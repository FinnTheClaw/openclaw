// Rejects caller-added memory authority fields without echoing their names.
export function assertExactGovernorMemoryInput(value: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("GOVERNOR_MEMORY_INPUT_FIELD_INVALID");
  }
}
