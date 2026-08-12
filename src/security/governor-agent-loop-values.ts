import type { GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedBoundarySafe } from "../tasks/governor/secret-filter.js";

export function safeGovernorAgentLoopValue(value: unknown): GovernorJsonValue {
  return assertGovernorPersistedBoundarySafe("model", value);
}

export function governorAgentLoopTopLevelString(
  value: GovernorJsonValue,
  key: string | undefined,
): string | undefined {
  if (!key || !value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}
