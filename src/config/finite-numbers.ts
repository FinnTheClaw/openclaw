// Reject values JSON.stringify would silently coerce to null in configuration payloads.
export function assertFiniteConfigNumbers<T>(value: T): T {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Value must be a finite number, got ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertFiniteConfigNumbers(entry);
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      assertFiniteConfigNumbers(entry);
    }
  }
  return value;
}

export function stringifyFiniteConfig(value: unknown): string {
  return JSON.stringify(assertFiniteConfigNumbers(value), null, 2).trimEnd().concat("\n");
}
