/**
 * Captures the coordinator's narrow, non-secret request evidence without
 * retaining provider response headers or affecting ordinary provider runs.
 */
import type { AssistantMessageEvent, AssistantMessageEventStreamLike } from "../llm/types.js";
import type { StreamFn } from "./runtime/index.js";

const FINN_REQUEST_ID_HEADER = "x-finn-request-id";
const FINN_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

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

export type FinnRequestEvidenceCollector = {
  requestIds: string[];
  complete: boolean;
};

type FinnRequestEvidence = {
  requestIds: readonly string[];
  complete: boolean;
};

export function createFinnRequestEvidenceCollector(): FinnRequestEvidenceCollector {
  return { requestIds: [], complete: true };
}

function attachFinnRequestIdEvidence(message: unknown, evidence: FinnRequestEvidence): void {
  if (evidence.requestIds.length === 0 || !message || typeof message !== "object") {
    return;
  }
  const target = message as {
    finnRequestIds?: string[];
    finnRequestIdEvidenceComplete?: boolean;
  };
  target.finnRequestIds = [...evidence.requestIds];
  target.finnRequestIdEvidenceComplete = evidence.complete;
}

function annotateEvent(event: AssistantMessageEvent, evidence: FinnRequestEvidence): void {
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
  currentEvidence: () => FinnRequestEvidence,
): AssistantMessageEventStreamLike {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        annotateEvent(event, currentEvidence());
        yield event;
      }
    },
    async result() {
      const message = await source.result();
      attachFinnRequestIdEvidence(message, currentEvidence());
      return message;
    },
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

/**
 * Adds scoped response evidence to one provider invocation. Each wrapper owns
 * its request id, so concurrent turns cannot overwrite one another.
 */
export function wrapFinnRequestIdEvidence(streamFn: StreamFn): StreamFn {
  return wrapFinnRequestIdEvidenceWithCollector(streamFn, createFinnRequestEvidenceCollector());
}

/** Shares bounded evidence across every provider call in one agent turn. */
export function wrapFinnRequestIdEvidenceWithCollector(
  streamFn: StreamFn,
  collector: FinnRequestEvidenceCollector,
): StreamFn {
  return (model, context, options) => {
    const originalOnResponse = options?.onResponse;
    const source = streamFn(model, context, {
      ...options,
      onResponse: async (response, responseModel) => {
        const requestId = readFinnRequestId(response.headers);
        if (!requestId || collector.requestIds.length >= 16) {
          collector.complete = false;
        } else {
          collector.requestIds.push(requestId);
        }
        await originalOnResponse?.(response, responseModel);
      },
    });
    const relay = (resolved: Awaited<ReturnType<StreamFn>>) =>
      relayFinnRequestIdEvidence(resolved, () => ({
        requestIds: collector.requestIds,
        complete: collector.complete,
      }));
    return isPromiseLike(source) ? Promise.resolve(source).then(relay) : relay(source);
  };
}
