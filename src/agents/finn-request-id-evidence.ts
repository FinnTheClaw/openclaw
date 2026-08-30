/**
 * Captures bounded request evidence only for the resolved Finn coordinator
 * route that is actually dispatched by the embedded agent runtime.
 */
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  Model,
} from "../llm/types.js";
import type { StreamFn } from "./runtime/index.js";

const FINN_REQUEST_ID_HEADER = "x-finn-request-id";
const FINN_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FINN_COORDINATOR_PROVIDER = "remote-llm";
const FINN_COORDINATOR_BASE_URL = "http://127.0.0.1:8300/v1";
const FINN_COORDINATOR_ROUTE_PATTERN = /^moira\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FINN_REQUEST_IDS = 16;

type FinnCoordinatorRouteIdentity = Readonly<{
  provider: typeof FINN_COORDINATOR_PROVIDER;
  baseUrl: typeof FINN_COORDINATOR_BASE_URL;
  route: string;
}>;

type FinnRequestEvidenceEntry = Readonly<{
  requestId: string;
  route: FinnCoordinatorRouteIdentity;
}>;

type FinnRequestEvidenceSnapshot = Readonly<{
  requests: readonly FinnRequestEvidenceEntry[];
  requestIds: readonly string[];
  hasCoordinatorAttempt: boolean;
  complete: boolean;
}>;

type MutableAttempt = {
  route: FinnCoordinatorRouteIdentity;
  closed: boolean;
};

type MutableCollectorState = {
  attempts: MutableAttempt[];
  requests: FinnRequestEvidenceEntry[];
  seenRequestIds: Set<string>;
  sawNonCoordinatorAttempt: boolean;
  overflowed: boolean;
};

export type FinnRequestEvidenceCollector = Readonly<{
  snapshot: () => FinnRequestEvidenceSnapshot;
  beginAttempt: (model: Model) => ((headers: unknown) => void) | undefined;
}>;

/** Returns only the coordinator's syntactically valid request identifier. */
export function readFinnRequestId(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  let requestId: string | undefined;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() !== FINN_REQUEST_ID_HEADER) {
      continue;
    }
    if (
      requestId !== undefined ||
      typeof value !== "string" ||
      !FINN_REQUEST_ID_PATTERN.test(value)
    ) {
      return undefined;
    }
    requestId = value;
  }
  return requestId;
}

function resolveFinnCoordinatorRoute(model: Model): FinnCoordinatorRouteIdentity | undefined {
  if (
    model.provider !== FINN_COORDINATOR_PROVIDER ||
    model.baseUrl !== FINN_COORDINATOR_BASE_URL ||
    !FINN_COORDINATOR_ROUTE_PATTERN.test(model.id)
  ) {
    return undefined;
  }
  const url = new URL(model.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "8300" ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: FINN_COORDINATOR_PROVIDER,
    baseUrl: FINN_COORDINATOR_BASE_URL,
    route: model.id,
  });
}

function snapshotCollector(state: MutableCollectorState): FinnRequestEvidenceSnapshot {
  const hasCoordinatorAttempt = state.attempts.length > 0;
  const complete =
    hasCoordinatorAttempt &&
    !state.sawNonCoordinatorAttempt &&
    !state.overflowed &&
    state.attempts.every((attempt) => attempt.closed);
  const requests = Object.freeze([...state.requests]);
  return Object.freeze({
    requests,
    requestIds: Object.freeze(requests.map((entry) => entry.requestId)),
    hasCoordinatorAttempt,
    complete,
  });
}

export function createFinnRequestEvidenceCollector(): FinnRequestEvidenceCollector {
  const state: MutableCollectorState = {
    attempts: [],
    requests: [],
    seenRequestIds: new Set(),
    sawNonCoordinatorAttempt: false,
    overflowed: false,
  };
  return Object.freeze({
    snapshot: () => snapshotCollector(state),
    beginAttempt: (model: Model) => {
      const route = resolveFinnCoordinatorRoute(model);
      if (!route) {
        state.sawNonCoordinatorAttempt = true;
        return undefined;
      }
      const attempt = { route, closed: false };
      state.attempts.push(attempt);
      return (headers: unknown) => observeResponse(state, attempt, headers);
    },
  });
}

function observeResponse(
  state: MutableCollectorState,
  attempt: MutableAttempt,
  headers: unknown,
): void {
  const requestId = readFinnRequestId(headers);
  if (!requestId) {
    return;
  }
  attempt.closed = true;
  if (state.seenRequestIds.has(requestId)) {
    return;
  }
  if (state.requests.length >= MAX_FINN_REQUEST_IDS) {
    state.overflowed = true;
    return;
  }
  state.seenRequestIds.add(requestId);
  state.requests.push(Object.freeze({ requestId, route: attempt.route }));
}

function attachFinnRequestIdEvidence(
  message: unknown,
  evidence: FinnRequestEvidenceSnapshot,
): void {
  if (!evidence.hasCoordinatorAttempt || !message || typeof message !== "object") {
    return;
  }
  const target = message as {
    finnRequestIds?: readonly string[];
    finnRequestIdEvidenceComplete?: boolean;
  };
  target.finnRequestIds = evidence.requestIds;
  target.finnRequestIdEvidenceComplete = evidence.complete;
}

function annotateEvent(event: AssistantMessageEvent, evidence: FinnRequestEvidenceSnapshot): void {
  switch (event.type) {
    case "done":
      attachFinnRequestIdEvidence(event.message, evidence);
      return;
    case "error":
      attachFinnRequestIdEvidence(event.error, evidence);
      return;
    default:
      if ("partial" in event && event.partial) {
        attachFinnRequestIdEvidence(event.partial, evidence);
      }
  }
}

function relayFinnRequestIdEvidence(
  source: Awaited<ReturnType<StreamFn>>,
  collector: FinnRequestEvidenceCollector,
): AssistantMessageEventStreamLike {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        annotateEvent(event, collector.snapshot());
        yield event;
      }
    },
    async result() {
      const message = await source.result();
      attachFinnRequestIdEvidence(message, collector.snapshot());
      return message;
    },
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

export function wrapFinnRequestIdEvidence(streamFn: StreamFn): StreamFn {
  return wrapFinnRequestIdEvidenceWithCollector(streamFn, createFinnRequestEvidenceCollector());
}

export function wrapFinnRequestIdEvidenceWithCollector(
  streamFn: StreamFn,
  collector: FinnRequestEvidenceCollector,
): StreamFn {
  return (model, context, options) => {
    // Opening before the transport call makes throws/rejections observable as unfinished attempts.
    const observeAttemptResponse = collector.beginAttempt(model);
    const originalOnResponse = options?.onResponse;
    const source = streamFn(model, context, {
      ...options,
      onResponse: async (response, responseModel) => {
        observeAttemptResponse?.(response.headers);
        await originalOnResponse?.(response, responseModel);
      },
    });
    const relay = (resolved: Awaited<ReturnType<StreamFn>>) =>
      relayFinnRequestIdEvidence(resolved, collector);
    return isPromiseLike(source) ? Promise.resolve(source).then(relay) : relay(source);
  };
}
