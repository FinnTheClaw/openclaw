/**
 * Captures bounded request evidence only for the resolved Finn coordinator
 * route that is actually dispatched by the embedded agent runtime.
 */
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  Model,
} from "../llm/types.js";
import { isBuiltInProviderTransport } from "./finn-request-id-transport.js";
import type { StreamFn } from "./runtime/index.js";

const FINN_REQUEST_ID_HEADER = "x-finn-request-id";
const FINN_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FINN_COORDINATOR_PROVIDER = "remote-llm";
const FINN_COORDINATOR_LOCAL_BASE_URL = "http://127.0.0.1:8300/v1";
const FINN_COORDINATOR_EDGE_BASE_URL = "https://coordinator.tinolafarms.com:8443/v1";
const FINN_COORDINATOR_ROUTE_PATTERN = /^moira\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FINN_REQUEST_IDS = 16;

type FinnCoordinatorRouteIdentity = Readonly<{
  provider: typeof FINN_COORDINATOR_PROVIDER;
  baseUrl: typeof FINN_COORDINATOR_LOCAL_BASE_URL | typeof FINN_COORDINATOR_EDGE_BASE_URL;
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
  responseCount: number;
  finished: boolean;
};

type MutableCollectorState = {
  attempts: MutableAttempt[];
  requests: FinnRequestEvidenceEntry[];
  seenRequestIds: Set<string>;
  invalid: boolean;
};

type FinnRequestAttemptObserver = Readonly<{
  observeResponse: (headers: unknown) => void;
  finish: () => void;
  fail: () => void;
}>;

export type FinnRequestEvidenceCollector = Readonly<{
  snapshot: () => FinnRequestEvidenceSnapshot;
  beginAttempt: (route: FinnCoordinatorRouteIdentity | undefined) => FinnRequestAttemptObserver;
}>;

type FinnRequestEvidenceTransportBinding = Readonly<{
  selectedStreamFn: StreamFn;
  resolvedModel: Model;
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
  const baseUrl = model.baseUrl;
  if (
    model.provider !== FINN_COORDINATOR_PROVIDER ||
    (baseUrl !== FINN_COORDINATOR_LOCAL_BASE_URL && baseUrl !== FINN_COORDINATOR_EDGE_BASE_URL) ||
    !FINN_COORDINATOR_ROUTE_PATTERN.test(model.id)
  ) {
    return undefined;
  }
  const url = new URL(baseUrl);
  const isLocal = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "8300";
  const isEdge =
    url.protocol === "https:" &&
    url.hostname === "coordinator.tinolafarms.com" &&
    url.port === "8443";
  if (
    (!isLocal && !isEdge) ||
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
    baseUrl,
    route: model.id,
  });
}

function snapshotCollector(state: MutableCollectorState): FinnRequestEvidenceSnapshot {
  const hasCoordinatorAttempt = state.attempts.length > 0;
  const complete =
    hasCoordinatorAttempt &&
    !state.invalid &&
    state.attempts.every((attempt) => attempt.finished && attempt.responseCount === 1);
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
    invalid: false,
  };
  return Object.freeze({
    snapshot: () => snapshotCollector(state),
    beginAttempt: (route: FinnCoordinatorRouteIdentity | undefined) => {
      if (!route) {
        state.invalid = true;
        return Object.freeze({
          observeResponse: () => undefined,
          finish: () => undefined,
          fail: () => undefined,
        });
      }
      const attempt = { route, responseCount: 0, finished: false };
      state.attempts.push(attempt);
      return Object.freeze({
        observeResponse: (headers: unknown) => observeResponse(state, attempt, headers),
        finish: () => finishAttempt(state, attempt),
        fail: () => failAttempt(state, attempt),
      });
    },
  });
}

function observeResponse(
  state: MutableCollectorState,
  attempt: MutableAttempt,
  headers: unknown,
): void {
  if (attempt.finished || attempt.responseCount > 0) {
    state.invalid = true;
  }
  attempt.responseCount += 1;
  const requestId = readFinnRequestId(headers);
  if (!requestId) {
    state.invalid = true;
    return;
  }
  if (state.seenRequestIds.has(requestId)) {
    return;
  }
  if (state.requests.length >= MAX_FINN_REQUEST_IDS) {
    state.invalid = true;
    return;
  }
  state.seenRequestIds.add(requestId);
  state.requests.push(Object.freeze({ requestId, route: attempt.route }));
}

function finishAttempt(state: MutableCollectorState, attempt: MutableAttempt): void {
  if (attempt.finished) {
    return;
  }
  attempt.finished = true;
  if (attempt.responseCount !== 1) {
    state.invalid = true;
  }
}

function failAttempt(state: MutableCollectorState, attempt: MutableAttempt): void {
  state.invalid = true;
  attempt.finished = true;
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
  attempt: FinnRequestAttemptObserver,
): AssistantMessageEventStreamLike {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source) {
          if (event.type === "done") {
            attempt.finish();
          } else if (event.type === "error") {
            attempt.fail();
          }
          annotateEvent(event, collector.snapshot());
          yield event;
        }
        attempt.finish();
      } catch (error) {
        attempt.fail();
        throw error;
      }
    },
    async result() {
      try {
        const message = await source.result();
        attempt.finish();
        attachFinnRequestIdEvidence(message, collector.snapshot());
        return message;
      } catch (error) {
        attempt.fail();
        throw error;
      }
    },
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

export function wrapFinnRequestIdEvidenceWithCollector(
  streamFn: StreamFn,
  collector: FinnRequestEvidenceCollector,
  binding?: FinnRequestEvidenceTransportBinding,
): StreamFn {
  const boundRoute =
    binding && isBuiltInProviderTransport(binding.selectedStreamFn)
      ? resolveFinnCoordinatorRoute(binding.resolvedModel)
      : undefined;
  return (model, context, options) => {
    const invocationRoute = resolveFinnCoordinatorRoute(model);
    const route =
      boundRoute &&
      invocationRoute &&
      boundRoute.provider === invocationRoute.provider &&
      boundRoute.baseUrl === invocationRoute.baseUrl &&
      boundRoute.route === invocationRoute.route
        ? boundRoute
        : undefined;
    const attempt = collector.beginAttempt(route);
    const originalOnResponse = options?.onResponse;
    let source: ReturnType<StreamFn>;
    try {
      source = streamFn(model, context, {
        ...options,
        onResponse: async (response, responseModel) => {
          attempt.observeResponse(response.headers);
          await originalOnResponse?.(response, responseModel);
        },
      });
    } catch (error) {
      attempt.fail();
      throw error;
    }
    const relay = (resolved: Awaited<ReturnType<StreamFn>>) =>
      relayFinnRequestIdEvidence(resolved, collector, attempt);
    return isPromiseLike(source)
      ? Promise.resolve(source).then(relay, (error: unknown) => {
          attempt.fail();
          throw error;
        })
      : relay(source);
  };
}
