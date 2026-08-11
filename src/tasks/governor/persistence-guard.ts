// Applies bounded resource, secret, and opaque-identity checks at durable write boundaries.
import type { GovernorJsonValue } from "./canonical-json.js";
import {
  assertGovernorPersistedBoundarySafe,
  type GovernorSecretBoundary,
} from "./secret-filter.js";
import {
  isOpaqueGovernorReference,
  type GovernorTaskProjection,
  type GovernorTaskScope,
} from "./types.js";

export function assertGovernorPersistedJson(
  boundary: GovernorSecretBoundary,
  value: unknown,
): GovernorJsonValue {
  return assertGovernorPersistedBoundarySafe(boundary, value);
}

export function assertOpaqueGovernorScope(scope: GovernorTaskScope, scopeKey: string): void {
  const expectedFields = [
    "accountId",
    "agentId",
    "channel",
    "conversationId",
    "principalId",
    "sessionId",
    "workspaceId",
  ];
  if (
    !isOpaqueGovernorReference(scopeKey) ||
    JSON.stringify(Object.keys(scope).toSorted()) !== JSON.stringify(expectedFields) ||
    Object.values(scope).some(
      (value) => typeof value !== "string" || !isOpaqueGovernorReference(value),
    )
  ) {
    throw new Error("Governor durable scope identity is not host-opaque");
  }
}

export function assertSameGovernorScope(
  expected: GovernorTaskProjection,
  candidate: GovernorTaskProjection,
): void {
  assertOpaqueGovernorScope(candidate.scope, candidate.scopeKey);
  if (
    candidate.scopeKey !== expected.scopeKey ||
    Object.keys(expected.scope).some(
      (key) =>
        candidate.scope[key as keyof GovernorTaskScope] !==
        expected.scope[key as keyof GovernorTaskScope],
    )
  ) {
    throw new Error("Governor durable scope identity does not match host-authoritative state");
  }
}
