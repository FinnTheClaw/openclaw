/** Test-only C03 data; it cannot create, select, or close a governor module. */
export type C03CampaignClass =
  | "baseline-loop"
  | "transient-retry"
  | "non-guidance-replan"
  | "premature-finish"
  | "restart-lifecycle";

export type C03TraceEvent =
  | Readonly<{
      turn: number;
      kind: "observation";
      observationKey: string;
      result: "success" | "transient-failure";
      actionId: string;
      effectId: string;
      outcomeId: string;
    }>
  | Readonly<{ turn: number; kind: "replan"; guidance: false }>
  | Readonly<{ turn: number; kind: "finish-rejected"; reason: "incomplete" }>
  | Readonly<{
      turn: number;
      kind: "aggregate";
      actionId: string;
      effectId: string;
      outcomeId: string;
    }>;

export type C03TraceError =
  | "C03_TRACE_COUNT_INVALID"
  | "C03_TRACE_DUPLICATE_LABEL"
  | "C03_TRACE_INVENTED_KEY"
  | "C03_TRACE_ORPHAN_OUTCOME"
  | "C03_TRACE_ORDER_OR_VALUE_INVALID";

type C03UntimedTraceEvent = C03TraceEvent extends infer Event
  ? Event extends { turn: number }
    ? Omit<Event, "turn">
    : never
  : never;

export type C03DeepLoopCampaignCase = Readonly<{
  id: string;
  caseClass: C03CampaignClass;
  prompt: string;
  expectedTrace: readonly C03TraceEvent[];
  restartAfterObservations?: 8 | 12;
}>;

const SUBJECTS = Object.freeze([
  "dependency graph",
  "service runbook",
  "filesystem inventory",
  "network route",
  "build receipt",
  "test bundle",
  "configuration snapshot",
  "release manifest",
  "runtime sample",
  "incident timeline",
] as const);
const CLASSES = Object.freeze([
  "baseline-loop",
  "transient-retry",
  "non-guidance-replan",
  "premature-finish",
  "restart-lifecycle",
] as const satisfies readonly C03CampaignClass[]);

export const C03_CANONICAL_OBSERVATION_KEYS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `observe-${String(index + 1).padStart(2, "0")}`),
);

function promptFor(params: { subject: string; id: string }): string {
  return [
    `C03 isolated no-side-effect task ${params.id}: investigate the ${params.subject}.`,
    "Use only the supplied observation tool for the twenty canonical observation keys.",
    "Recover from one injected transient failure with one non-guidance replan and retry.",
    "Reject the injected premature finish, then aggregate once after all successes.",
  ].join(" ");
}

function physicalIds(key: string, attempt: number) {
  const suffix = `${key}:attempt-${attempt}`;
  return {
    actionId: `action:${suffix}`,
    effectId: `effect:${suffix}`,
    outcomeId: `outcome:${suffix}`,
  } as const;
}

function expectedTraceFor(index: number): readonly C03TraceEvent[] {
  const failedKey = C03_CANONICAL_OBSERVATION_KEYS[index % 20]!;
  const finishAfterSuccesses = 3 + (index % 15);
  const events: C03UntimedTraceEvent[] = [];
  let successes = 0;
  for (const observationKey of C03_CANONICAL_OBSERVATION_KEYS) {
    if (observationKey === failedKey) {
      events.push({
        kind: "observation",
        observationKey,
        result: "transient-failure",
        ...physicalIds(observationKey, 1),
      });
      events.push({ kind: "replan", guidance: false });
    }
    const attempt = observationKey === failedKey ? 2 : 1;
    events.push({
      kind: "observation",
      observationKey,
      result: "success",
      ...physicalIds(observationKey, attempt),
    });
    successes += 1;
    if (successes === finishAfterSuccesses) {
      events.push({ kind: "finish-rejected", reason: "incomplete" });
    }
  }
  events.push({ kind: "aggregate", ...physicalIds("aggregate", 1) });
  return Object.freeze(
    events.map((event, turn) => Object.freeze({ ...event, turn: turn + 1 }) as C03TraceEvent),
  );
}

function isPhysical(
  event: C03TraceEvent,
): event is Extract<C03TraceEvent, { kind: "observation" | "aggregate" }> {
  return event.kind === "observation" || event.kind === "aggregate";
}

export function validateC03Trace(
  campaignCase: C03DeepLoopCampaignCase,
  trace: readonly C03TraceEvent[],
): readonly C03TraceError[] {
  const errors = new Set<C03TraceError>();
  if (trace.length !== 24) errors.add("C03_TRACE_COUNT_INVALID");
  const observationEvents = trace.filter(
    (event): event is Extract<C03TraceEvent, { kind: "observation" }> =>
      event.kind === "observation",
  );
  const successfulKeys = observationEvents
    .filter((event) => event.result === "success")
    .map((event) => event.observationKey);
  if (new Set(successfulKeys).size !== successfulKeys.length) {
    errors.add("C03_TRACE_DUPLICATE_LABEL");
  }
  if (
    observationEvents.some(
      (event) => !C03_CANONICAL_OBSERVATION_KEYS.includes(event.observationKey),
    )
  ) {
    errors.add("C03_TRACE_INVENTED_KEY");
  }
  if (
    trace.some(
      (event) => isPhysical(event) && (!event.actionId || !event.effectId || !event.outcomeId),
    )
  ) {
    errors.add("C03_TRACE_ORPHAN_OUTCOME");
  }
  if (JSON.stringify(trace) !== JSON.stringify(campaignCase.expectedTrace)) {
    errors.add("C03_TRACE_ORDER_OR_VALUE_INVALID");
  }
  return Object.freeze([...errors].toSorted());
}

function caseFor(index: number): C03DeepLoopCampaignCase {
  const caseClass = CLASSES[Math.floor(index / (SUBJECTS.length * 2))]!;
  const id = `C03-${String(index + 1).padStart(3, "0")}`;
  return Object.freeze({
    id,
    caseClass,
    prompt: promptFor({ id, subject: SUBJECTS[index % SUBJECTS.length]! }),
    expectedTrace: expectedTraceFor(index),
    ...(caseClass === "restart-lifecycle" ? { restartAfterObservations: index % 2 ? 8 : 12 } : {}),
  });
}

/** Exactly 100 cases for later installed C03 certification with local Qwen. */
export const C03_DEEP_LOOP_CAMPAIGN = Object.freeze(
  Array.from({ length: CLASSES.length * SUBJECTS.length * 2 }, (_, index) => caseFor(index)),
);
