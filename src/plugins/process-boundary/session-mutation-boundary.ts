export type MutationAttempt = Readonly<{ readonly __mutationAttempt: unique symbol }>;

export function createSessionMutationBoundary(onReentry: () => void) {
  let active: MutationAttempt | undefined;
  let invalidated = false;

  function enter(): MutationAttempt | undefined {
    if (active) {
      if (!invalidated) {
        invalidated = true;
        onReentry();
      }
      return undefined;
    }
    active = Object.freeze({}) as MutationAttempt;
    invalidated = false;
    return active;
  }

  function current(attempt: MutationAttempt): boolean {
    return active === attempt && !invalidated;
  }

  function leave(attempt: MutationAttempt): void {
    if (active === attempt) {
      active = undefined;
      invalidated = false;
    }
  }

  return Object.freeze({ enter, current, leave });
}
