const HOST_EVIDENCE = new WeakMap<object, Readonly<Record<string, unknown>>>();

/** @internal Closure-owned channel between the installed bridge and its enclosing run. */
export function bindGovernorLoopAttemptEvidence<T extends object>(
  attempt: T,
  evidence: Readonly<Record<string, unknown>> | undefined,
): T {
  if (evidence) {
    HOST_EVIDENCE.set(attempt, evidence);
  }
  return attempt;
}

/** @internal Provider and custom-stream message objects are never keys in this channel. */
export function resolveGovernorLoopAttemptEvidence(
  attempt: object,
): Readonly<Record<string, unknown>> | undefined {
  return HOST_EVIDENCE.get(attempt);
}
