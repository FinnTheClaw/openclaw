import { FINN_REQUEST_ID, dataRecord, fail } from "./governor-c02-runtime-attestation-model.js";

function requireSafeRequestIdArray(value: unknown): readonly string[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(
        ([key, descriptor]) =>
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/u.test(key) || !descriptor.enumerable || !("value" in descriptor)),
      ) ||
      value.some((item) => typeof item !== "string" || !FINN_REQUEST_ID.test(item)) ||
      new Set(value).size !== value.length
    ) {
      fail();
    }
    return Object.freeze([...value] as string[]);
  } catch {
    fail();
  }
}

export function requireCumulativeFinnRequestIds(
  value: unknown,
  complete: unknown,
  prior: readonly string[],
): readonly string[] {
  const current = requireSafeRequestIdArray(value);
  if (
    complete !== true ||
    current.length !== prior.length + 1 ||
    prior.some((item, index) => current[index] !== item)
  ) {
    fail();
  }
  return current;
}

export function mergeFreshFinnRequestIds(params: {
  value: unknown;
  complete: unknown;
  freshPrior: readonly string[];
  durablePrior: readonly string[];
}): Readonly<{ fresh: readonly string[]; merged: readonly string[] }> {
  const fresh = requireCumulativeFinnRequestIds(params.value, params.complete, params.freshPrior);
  if (fresh.some((requestId) => params.durablePrior.includes(requestId))) {
    fail();
  }
  return Object.freeze({
    fresh,
    merged: Object.freeze([...params.durablePrior, ...fresh]),
  });
}

export function loadDurableFinnRequestIds(
  events: readonly Readonly<{ eventType: string; payload: unknown }>[],
  executionGeneration: number | undefined,
): readonly string[] {
  let durable: readonly string[] = [];
  for (const event of events) {
    const payload = dataRecord(event.payload);
    if (
      payload &&
      event.eventType === "runtime_model_turn_recorded" &&
      payload.executionGeneration === executionGeneration
    ) {
      durable = requireCumulativeFinnRequestIds(
        payload.finnRequestIds,
        payload.finnRequestIdEvidenceComplete,
        durable,
      );
    }
  }
  return durable;
}
