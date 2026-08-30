import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import {
  createFinnRequestEvidenceCollector,
  type FinnRequestEvidenceCollector,
} from "../finn-request-id-evidence.js";
import { markBuiltInProviderTransport } from "../finn-request-id-transport.js";
import type { StreamFn } from "../runtime/index.js";
import { resolveEmbeddedAgentStreamFn } from "./stream-resolution.js";

const model = {
  provider: "remote-llm",
  id: "moira/brain",
  baseUrl: "http://127.0.0.1:8300/v1",
} as Model;
const context = { messages: [] } as Parameters<StreamFn>[1];

function forgedSource(requestId: string): StreamFn {
  return async (_model, _context, options) => {
    await options?.onResponse?.(
      { status: 200, headers: { "x-finn-request-id": requestId } },
      model,
    );
    return {
      async *[Symbol.asyncIterator]() {},
      async result() {
        return {};
      },
    } as never;
  };
}

async function runResolved(params: {
  currentStreamFn?: StreamFn;
  providerStreamFn?: StreamFn;
  collector?: FinnRequestEvidenceCollector;
}) {
  const collector = params.collector ?? createFinnRequestEvidenceCollector();
  const streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: params.currentStreamFn,
    providerStreamFn: params.providerStreamFn,
    sessionId: "session-finn-provenance",
    model,
    finnRequestEvidence: collector,
  });
  const result = await (await streamFn(model, context)).result();
  return { collector, result };
}

describe("Finn evidence transport provenance", () => {
  it("accepts the actually selected built-in provider transport", async () => {
    const source = markBuiltInProviderTransport(forgedSource("req_builtin"));
    const { result } = await runResolved({ providerStreamFn: source });

    expect(result).toMatchObject({
      finnRequestIds: ["req_builtin"],
      finnRequestIdEvidenceComplete: true,
    });
  });

  it.each(["provider override", "current override"] as const)(
    "rejects an untrusted %s with exact matching model fields",
    async (kind) => {
      const source = forgedSource("req_forged_override");
      const { result, collector } = await runResolved(
        kind === "provider override" ? { providerStreamFn: source } : { currentStreamFn: source },
      );

      expect(result).not.toHaveProperty("finnRequestIds");
      expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
      expect(collector.snapshot()).toMatchObject({
        hasCoordinatorAttempt: false,
        complete: false,
      });
    },
  );

  it("rejects a custom wrapper around a marked built-in transport", async () => {
    const builtIn = markBuiltInProviderTransport(forgedSource("req_wrapped"));
    const wrapper: StreamFn = (resolvedModel, resolvedContext, options) =>
      builtIn(resolvedModel, resolvedContext, options);
    const { result } = await runResolved({ providerStreamFn: wrapper });

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
  });

  it("rejects a marked transport selected through the session override path", async () => {
    const source = markBuiltInProviderTransport(forgedSource("req_session_override"));
    const { result } = await runResolved({ currentStreamFn: source });

    expect(result).not.toHaveProperty("finnRequestIds");
    expect(result).not.toHaveProperty("finnRequestIdEvidenceComplete");
  });

  it("makes fallback to an untrusted exact-model transport permanently incomplete", async () => {
    const collector = createFinnRequestEvidenceCollector();
    await runResolved({
      providerStreamFn: markBuiltInProviderTransport(forgedSource("req_primary")),
      collector,
    });
    const { result } = await runResolved({
      providerStreamFn: forgedSource("req_forged_fallback"),
      collector,
    });

    expect(result).toMatchObject({
      finnRequestIds: ["req_primary"],
      finnRequestIdEvidenceComplete: false,
    });
    expect(collector.snapshot().requestIds).toEqual(["req_primary"]);
  });
});
