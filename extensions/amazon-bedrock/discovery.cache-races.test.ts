// Deterministic Bedrock cache-boundary cases; no AWS client or credentials.
import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { describe, expect, it, vi } from "vitest";
import { discoverBedrockModels, resolveImplicitBedrockProvider } from "./api.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Generation = {
  started: ReturnType<typeof deferred<void>>;
  foundation: ReturnType<typeof deferred<{ modelSummaries: Record<string, unknown>[] }>>;
  abortOnSignal: boolean;
  succeed: (label: string) => void;
  fail: (reason?: unknown) => void;
};

let regionSequence = 0;
function region(): string {
  regionSequence += 1;
  return "cache-boundary-" + regionSequence;
}

function createHarness() {
  const pending: Generation[] = [];
  const created: Generation[] = [];
  const reserve = (abortOnSignal = false): Generation => {
    const started = deferred<void>();
    const foundation = deferred<{ modelSummaries: Record<string, unknown>[] }>();
    const generation: Generation = {
      started,
      foundation,
      abortOnSignal,
      succeed: (label) =>
        foundation.resolve({
          modelSummaries: [
            {
              modelId: "fixture." + label,
              modelName: label,
              providerName: "fixture",
              inputModalities: ["TEXT"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true,
              modelLifecycle: { status: "ACTIVE" },
            },
          ],
        }),
      fail: (reason = new Error("foundation failed")) => foundation.reject(reason),
    };
    pending.push(generation);
    return generation;
  };
  const clientFactory = (_region: string): BedrockClient => {
    const generation = pending.shift();
    if (!generation) {
      throw new Error("unexpected discovery instead of a cache hit");
    }
    created.push(generation);
    return {
      send: (
        command: { constructor: { name: string } },
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (command.constructor.name === "ListFoundationModelsCommand") {
          if (generation.abortOnSignal) {
            options?.abortSignal?.addEventListener(
              "abort",
              () => generation.fail(options.abortSignal?.reason ?? new Error("aborted")),
              { once: true },
            );
          }
          generation.started.resolve();
          return generation.foundation.promise;
        }
        if (command.constructor.name === "ListInferenceProfilesCommand") {
          return Promise.resolve({ inferenceProfileSummaries: [] });
        }
        throw new Error("unexpected Bedrock command");
      },
      destroy: () => {},
    } as unknown as BedrockClient;
  };
  const discover = (key: string, now: number, refreshInterval = 1) =>
    discoverBedrockModels({
      region: key,
      now: () => now,
      config: { refreshInterval },
      clientFactory,
    });
  return { reserve, created, clientFactory, discover };
}

async function expiredPair(harness: ReturnType<typeof createHarness>, key: string) {
  const a = harness.reserve();
  const first = harness.discover(key, 0);
  await a.started.promise;
  const b = harness.reserve();
  const second = harness.discover(key, 1_000);
  await b.started.promise;
  return { a, b, first, second };
}

async function ids(result: ReturnType<typeof discoverBedrockModels>): Promise<string[]> {
  return (await result).map((model) => model.id);
}

describe("Bedrock B01 cache ownership", () => {
  it("B01-01 newer value wins over late old success", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    b.succeed("b");
    expect(await ids(second)).toEqual(["fixture.b"]);
    a.succeed("a");
    expect(await ids(first)).toEqual(["fixture.a"]);
    expect(await ids(h.discover(key, 1_001))).toEqual(["fixture.b"]);
    expect(h.created).toHaveLength(2);
  });

  it("B01-02 old success cannot displace pending owner", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    a.succeed("a");
    expect(await ids(first)).toEqual(["fixture.a"]);
    const joined = h.discover(key, 1_001);
    b.succeed("b");
    expect(await ids(joined)).toEqual(["fixture.b"]);
    expect(await ids(second)).toEqual(["fixture.b"]);
    expect(h.created).toHaveLength(2);
  });

  it("B01-03 old failure cannot erase completed newer value", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    b.succeed("b");
    expect(await ids(second)).toEqual(["fixture.b"]);
    a.fail();
    expect(await ids(first)).toEqual([]);
    expect(await ids(h.discover(key, 1_001))).toEqual(["fixture.b"]);
    expect(h.created).toHaveLength(2);
  });

  it("B01-04 old failure cannot erase pending owner", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    a.fail();
    expect(await ids(first)).toEqual([]);
    const joined = h.discover(key, 1_001);
    b.succeed("b");
    expect(await ids(joined)).toEqual(["fixture.b"]);
    expect(await ids(second)).toEqual(["fixture.b"]);
    expect(h.created).toHaveLength(2);
  });

  it("B01-05 newer failure cannot revive later old success", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    b.fail();
    expect(await ids(second)).toEqual([]);
    a.succeed("a");
    expect(await ids(first)).toEqual(["fixture.a"]);
    const c = h.reserve();
    const third = h.discover(key, 1_001);
    await c.started.promise;
    c.succeed("c");
    expect(await ids(third)).toEqual(["fixture.c"]);
    expect(h.created).toHaveLength(3);
  });

  it("B01-06 newer failure evicts itself after old success", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    a.succeed("a");
    expect(await ids(first)).toEqual(["fixture.a"]);
    b.fail();
    expect(await ids(second)).toEqual([]);
    const c = h.reserve();
    const third = h.discover(key, 1_001);
    await c.started.promise;
    c.succeed("c");
    expect(await ids(third)).toEqual(["fixture.c"]);
    expect(h.created).toHaveLength(3);
  });

  it("B01-07 newest of three generations survives older successes", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    const c = h.reserve();
    const third = h.discover(key, 2_000);
    await c.started.promise;
    c.succeed("c");
    expect(await ids(third)).toEqual(["fixture.c"]);
    b.succeed("b");
    a.succeed("a");
    expect(await ids(second)).toEqual(["fixture.b"]);
    expect(await ids(first)).toEqual(["fixture.a"]);
    expect(await ids(h.discover(key, 2_001))).toEqual(["fixture.c"]);
    expect(h.created).toHaveLength(3);
  });

  it("B01-08 newest of three generations survives older failures", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    const c = h.reserve();
    const third = h.discover(key, 2_000);
    await c.started.promise;
    c.succeed("c");
    expect(await ids(third)).toEqual(["fixture.c"]);
    a.fail();
    b.fail();
    expect(await ids(first)).toEqual([]);
    expect(await ids(second)).toEqual([]);
    expect(await ids(h.discover(key, 2_001))).toEqual(["fixture.c"]);
    expect(h.created).toHaveLength(3);
  });

  it("B01-09 stale X completion leaves cached Y untouched", async () => {
    const h = createHarness();
    const x = region();
    const y = region();
    const yGeneration = h.reserve();
    const yCall = h.discover(y, 0);
    await yGeneration.started.promise;
    yGeneration.succeed("y");
    expect(await ids(yCall)).toEqual(["fixture.y"]);
    const { a, b, first, second } = await expiredPair(h, x);
    b.succeed("b");
    a.fail();
    expect(await ids(second)).toEqual(["fixture.b"]);
    expect(await ids(first)).toEqual([]);
    expect(await ids(h.discover(y, 1))).toEqual(["fixture.y"]);
    expect(h.created).toHaveLength(3);
  });

  it("B01-10 each caller keeps its own result without cache authority", async () => {
    const h = createHarness();
    const key = region();
    const { a, b, first, second } = await expiredPair(h, key);
    a.succeed("old");
    expect(await ids(first)).toEqual(["fixture.old"]);
    b.succeed("new");
    expect(await ids(second)).toEqual(["fixture.new"]);
    expect(await ids(h.discover(key, 1_001))).toEqual(["fixture.new"]);
    expect(h.created).toHaveLength(2);
  });
});

describe("Bedrock B02 shared in-flight failure", () => {
  it("B02-01 foundation failure resolves initiator and joiner to empty lists", async () => {
    const h = createHarness();
    const key = region();
    const a = h.reserve();
    const first = h.discover(key, 0, 60);
    await a.started.promise;
    const joined = h.discover(key, 1, 60);
    a.fail();
    expect(await ids(first)).toEqual([]);
    expect(await ids(joined)).toEqual([]);
    expect(h.created).toHaveLength(1);
  });

  it("B02-02 non-Error foundation rejection preserves the empty-list contract", async () => {
    const h = createHarness();
    const key = region();
    const a = h.reserve();
    const first = h.discover(key, 0, 60);
    await a.started.promise;
    const joined = h.discover(key, 1, 60);
    a.fail("rejected");
    expect(await ids(first)).toEqual([]);
    expect(await ids(joined)).toEqual([]);
    expect(h.created).toHaveLength(1);
  });

  it("B02-03 three joined callers all receive the same fallback", async () => {
    const h = createHarness();
    const key = region();
    const a = h.reserve();
    const first = h.discover(key, 0, 60);
    await a.started.promise;
    const joined = [h.discover(key, 1, 60), h.discover(key, 2, 60), h.discover(key, 3, 60)];
    a.fail();
    expect(await ids(first)).toEqual([]);
    for (const result of joined) {
      expect(await ids(result)).toEqual([]);
    }
    expect(h.created).toHaveLength(1);
  });

  it("B02-04 an aborted shared request resolves both calls to empty lists", async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const key = region();
      const a = h.reserve(true);
      const first = h.discover(key, 0, 60);
      await a.started.promise;
      const joined = h.discover(key, 1, 60);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await ids(first)).toEqual([]);
      expect(await ids(joined)).toEqual([]);
      expect(h.created).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B02-05 failed shared request is followed by a successful fresh discovery", async () => {
    const h = createHarness();
    const key = region();
    const a = h.reserve();
    const first = h.discover(key, 0, 60);
    await a.started.promise;
    const joined = h.discover(key, 1, 60);
    a.fail();
    expect(await ids(first)).toEqual([]);
    expect(await ids(joined)).toEqual([]);
    const b = h.reserve();
    const retry = h.discover(key, 2, 60);
    await b.started.promise;
    b.succeed("retry");
    expect(await ids(retry)).toEqual(["fixture.retry"]);
    expect(h.created).toHaveLength(2);
  });

  it("B02-06 repeated failed discovery never reuses a rejected promise", async () => {
    const h = createHarness();
    const key = region();
    for (const at of [0, 2]) {
      const generation = h.reserve();
      const first = h.discover(key, at, 60);
      await generation.started.promise;
      const joined = h.discover(key, at + 1, 60);
      generation.fail();
      expect(await ids(first)).toEqual([]);
      expect(await ids(joined)).toEqual([]);
    }
    expect(h.created).toHaveLength(2);
  });

  it("B02-07 concurrent implicit-provider callers both resolve null", async () => {
    const h = createHarness();
    const key = region();
    const params = {
      pluginConfig: { discovery: { enabled: true, region: key, refreshInterval: 60 } },
      env: {},
      clientFactory: h.clientFactory,
    };
    const a = h.reserve();
    const first = resolveImplicitBedrockProvider(params);
    await a.started.promise;
    const joined = resolveImplicitBedrockProvider(params);
    a.fail();
    await expect(first).resolves.toBeNull();
    await expect(joined).resolves.toBeNull();
    expect(h.created).toHaveLength(1);
  });

  it("B02-08 failure of X does not disturb Y discovery", async () => {
    const h = createHarness();
    const x = region();
    const y = region();
    const a = h.reserve();
    const first = h.discover(x, 0, 60);
    await a.started.promise;
    const joined = h.discover(x, 1, 60);
    const b = h.reserve();
    const other = h.discover(y, 0, 60);
    await b.started.promise;
    b.succeed("other");
    a.fail();
    expect(await ids(first)).toEqual([]);
    expect(await ids(joined)).toEqual([]);
    expect(await ids(other)).toEqual(["fixture.other"]);
    expect(await ids(h.discover(y, 1, 60))).toEqual(["fixture.other"]);
    expect(h.created).toHaveLength(2);
  });

  it("B02-09 successful in-flight sharing is unchanged", async () => {
    const h = createHarness();
    const key = region();
    const a = h.reserve();
    const first = h.discover(key, 0, 60);
    await a.started.promise;
    const joined = h.discover(key, 1, 60);
    a.succeed("good");
    expect(await ids(first)).toEqual(["fixture.good"]);
    expect(await ids(joined)).toEqual(["fixture.good"]);
    expect(h.created).toHaveLength(1);
  });

  it("B02-10 successive shared failures each settle without rejection", async () => {
    const h = createHarness();
    const key = region();
    for (const at of [0, 2]) {
      const generation = h.reserve();
      const first = h.discover(key, at, 60);
      await generation.started.promise;
      const joined = h.discover(key, at + 1, 60);
      generation.fail(new TypeError("failed generation"));
      const results = await Promise.all([ids(first), ids(joined)]);
      expect(results).toEqual([[], []]);
    }
    expect(h.created).toHaveLength(2);
  });
});
