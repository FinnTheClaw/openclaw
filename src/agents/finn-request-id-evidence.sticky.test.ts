import { describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import {
  createFinnRequestEvidenceCollector,
  wrapFinnRequestIdEvidenceWithCollector,
  type FinnRequestEvidenceCollector,
} from "./finn-request-id-evidence.js";
import { markBuiltInProviderTransport } from "./finn-request-id-transport.js";
import type { StreamFn } from "./runtime/index.js";

const model = {
  provider: "remote-llm",
  id: "moira/brain",
  baseUrl: "http://127.0.0.1:8300/v1",
} as Model;
const context = { messages: [] } as Parameters<StreamFn>[1];
type OnResponse = NonNullable<NonNullable<Parameters<StreamFn>[2]>["onResponse"]>;

function emptyStream(resultError?: Error) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      if (resultError) {
        throw resultError;
      }
      return {};
    },
  } as never;
}

function trusted(
  source: StreamFn,
  collector: FinnRequestEvidenceCollector = createFinnRequestEvidenceCollector(),
) {
  markBuiltInProviderTransport(source);
  return {
    collector,
    streamFn: wrapFinnRequestIdEvidenceWithCollector(source, collector, {
      selectedStreamFn: source,
      resolvedModel: model,
    }),
  };
}

function sourceWithCallbacks(headers: readonly Record<string, string>[]): StreamFn {
  return async (_model, _context, options) => {
    for (const responseHeaders of headers) {
      await options?.onResponse?.({ status: 200, headers: responseHeaders }, model);
    }
    return emptyStream();
  };
}

async function runCallbacks(headers: readonly Record<string, string>[]) {
  const wrapped = trusted(sourceWithCallbacks(headers));
  const result = await (await wrapped.streamFn(model, context)).result();
  return { result, snapshot: wrapped.collector.snapshot() };
}

describe("Finn request evidence sticky attempt accounting", () => {
  it("completes exactly one finalized response with one valid id", async () => {
    const { result, snapshot } = await runCallbacks([{ "x-finn-request-id": "req_one" }]);
    expect(result).toMatchObject({
      finnRequestIds: ["req_one"],
      finnRequestIdEvidenceComplete: true,
    });
    expect(snapshot.complete).toBe(true);
  });

  it.each([
    ["zero response", [], []],
    ["valid then missing", [{ "x-finn-request-id": "req_valid" }, {}], ["req_valid"]],
    [
      "valid then malformed",
      [{ "x-finn-request-id": "req_valid" }, { "x-finn-request-id": "bad" }],
      ["req_valid"],
    ],
    ["missing then valid", [{}, { "x-finn-request-id": "req_valid" }], ["req_valid"]],
    [
      "two equal valid responses",
      [{ "x-finn-request-id": "req_same" }, { "x-finn-request-id": "req_same" }],
      ["req_same"],
    ],
    [
      "two distinct valid responses",
      [{ "x-finn-request-id": "req_first" }, { "x-finn-request-id": "req_second" }],
      ["req_first", "req_second"],
    ],
  ] as const)("keeps incompleteness sticky for %s", async (_name, headers, expectedIds) => {
    const { result, snapshot } = await runCallbacks(headers);
    expect(result.finnRequestIds).toEqual(expectedIds);
    expect(result.finnRequestIdEvidenceComplete).toBe(false);
    expect(snapshot.complete).toBe(false);
  });

  it.each(["throw", "reject"] as const)("keeps valid→%s incomplete", async (mode) => {
    const sentinel = new Error(mode);
    const source: StreamFn =
      mode === "throw"
        ? (_model, _context, options) => {
            void options?.onResponse?.(
              { status: 200, headers: { "x-finn-request-id": "req_before_failure" } },
              model,
            );
            throw sentinel;
          }
        : async (_model, _context, options) => {
            await options?.onResponse?.(
              { status: 200, headers: { "x-finn-request-id": "req_before_failure" } },
              model,
            );
            throw sentinel;
          };
    const wrapped = trusted(source);

    if (mode === "throw") {
      expect(() => wrapped.streamFn(model, context)).toThrow(sentinel);
    } else {
      await expect(wrapped.streamFn(model, context)).rejects.toBe(sentinel);
    }
    expect(wrapped.collector.snapshot()).toMatchObject({
      requestIds: ["req_before_failure"],
      complete: false,
    });
  });

  it("invalidates callbacks arriving after finalization", async () => {
    let respond: OnResponse | undefined;
    const source: StreamFn = (_model, _context, options) => {
      respond = options?.onResponse;
      void respond?.({ status: 200, headers: { "x-finn-request-id": "req_timely" } }, model);
      return emptyStream();
    };
    const wrapped = trusted(source);
    await (await wrapped.streamFn(model, context)).result();
    await respond?.({ status: 200, headers: { "x-finn-request-id": "req_late" } }, model);

    expect(wrapped.collector.snapshot()).toMatchObject({
      requestIds: ["req_timely", "req_late"],
      complete: false,
    });
  });

  it("accounts for concurrent invocations until every invocation finishes", async () => {
    const collector = createFinnRequestEvidenceCollector();
    const first = trusted(
      sourceWithCallbacks([{ "x-finn-request-id": "req_concurrent_first" }]),
      collector,
    );
    const second = trusted(
      sourceWithCallbacks([{ "x-finn-request-id": "req_concurrent_second" }]),
      collector,
    );
    const [firstStream, secondStream] = await Promise.all([
      first.streamFn(model, context),
      second.streamFn(model, context),
    ]);

    expect(collector.snapshot().complete).toBe(false);
    await Promise.all([firstStream.result(), secondStream.result()]);
    expect(collector.snapshot()).toMatchObject({
      requestIds: ["req_concurrent_first", "req_concurrent_second"],
      complete: true,
    });
  });
});
