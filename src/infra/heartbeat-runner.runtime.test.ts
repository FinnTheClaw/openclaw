import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadPublished = vi.hoisted(() => vi.fn());
const configsMatch = vi.hoisted(() => vi.fn());
const resolveReply = vi.hoisted(() => vi.fn());
const bindRuntime = vi.hoisted(() => vi.fn());
const markFull = vi.hoisted(() => vi.fn());

vi.mock("../agents/prepared-model-runtime.js", () => ({
  loadPublishedGatewayReplyDispatchRuntime: loadPublished,
  preparedModelRuntimeConfigsMatch: configsMatch,
}));
vi.mock("../auto-reply/reply.js", () => ({ getReplyFromConfig: resolveReply }));
vi.mock("../auto-reply/reply/get-reply-fast-path.js", () => ({
  withFullRuntimeReplyConfig: markFull,
}));
vi.mock("../auto-reply/reply/prepared-reply-dispatch-context.js", () => ({
  bindPreparedReplyDispatchRuntime: bindRuntime,
}));

import { getHeartbeatReplyFromConfig } from "./heartbeat-runner.runtime.js";

type HeartbeatContext = Parameters<typeof getHeartbeatReplyFromConfig>[0];
type HeartbeatOptions = Parameters<typeof getHeartbeatReplyFromConfig>[1];

function context(agentId?: string): HeartbeatContext {
  return { AgentId: agentId, Body: "heartbeat" } as HeartbeatContext;
}

function config(marker: string): OpenClawConfig {
  return { agents: { defaults: { userTimezone: marker } } } as OpenClawConfig;
}

function publication(agentId: string, cfg: OpenClawConfig) {
  return { agentId, config: cfg, modelCatalog: { marker: agentId } };
}

beforeEach(() => {
  loadPublished.mockReset().mockResolvedValue(undefined);
  configsMatch
    .mockReset()
    .mockImplementation((left, right) => JSON.stringify(left) === JSON.stringify(right));
  resolveReply.mockReset().mockResolvedValue({ text: "HEARTBEAT_OK" });
  bindRuntime.mockReset().mockImplementation(
    (_runtime, run) =>
      (...args: unknown[]) =>
        run(...args),
  );
  markFull.mockReset().mockImplementation((cfg) => cfg);
});

describe("heartbeat config and published runtime", () => {
  it("H01 Published identity retains prepared runtime", async () => {
    const cfg = config("A");
    const runtime = publication("main", cfg);
    loadPublished.mockResolvedValue(runtime);
    await getHeartbeatReplyFromConfig(context("main"), undefined, cfg);
    expect(bindRuntime).toHaveBeenCalledWith(runtime, resolveReply);
    expect(resolveReply.mock.calls[0]).toHaveLength(2);
    expect(markFull).not.toHaveBeenCalled();
  });

  it("H02 Published clone retains prepared runtime", async () => {
    const cfg = config("A");
    loadPublished.mockResolvedValue(publication("main", config("A")));
    await getHeartbeatReplyFromConfig(context("main"), undefined, cfg);
    expect(bindRuntime).toHaveBeenCalledOnce();
    expect(resolveReply.mock.calls[0]).toHaveLength(2);
  });

  it("H03 Published divergent timezone uses exact per-run config", async () => {
    const cfg = config("New");
    loadPublished.mockResolvedValue(publication("main", config("Old")));
    await getHeartbeatReplyFromConfig(context("main"), undefined, cfg);
    expect(bindRuntime).not.toHaveBeenCalled();
    expect(markFull).toHaveBeenCalledWith(cfg);
    expect(resolveReply).toHaveBeenCalledWith(expect.any(Object), undefined, cfg);
  });

  it("H04 No publication preserves explicit config", async () => {
    const cfg = config("NoPublish");
    await getHeartbeatReplyFromConfig(context("main"), undefined, cfg);
    expect(bindRuntime).not.toHaveBeenCalled();
    expect(markFull).not.toHaveBeenCalled();
    expect(resolveReply).toHaveBeenCalledWith(expect.any(Object), undefined, cfg);
  });

  it("H05 Blank agent ID skips publication lookup", async () => {
    const cfg = config("Blank");
    await getHeartbeatReplyFromConfig(context("   "), undefined, cfg);
    expect(loadPublished).not.toHaveBeenCalled();
    expect(resolveReply.mock.calls[0]?.[2]).toBe(cfg);
  });

  it("H06 Missing agent ID skips publication lookup", async () => {
    const cfg = config("Missing");
    await getHeartbeatReplyFromConfig(context(), undefined, cfg);
    expect(loadPublished).not.toHaveBeenCalled();
    expect(resolveReply.mock.calls[0]?.[2]).toBe(cfg);
  });

  it("H07 Agent A and B bind only their own runtime", async () => {
    const a = config("A");
    const b = config("B");
    const runtimeA = publication("alpha", a);
    const runtimeB = publication("beta", b);
    loadPublished.mockImplementation(async ({ agentId }: { agentId: string }) =>
      agentId === "alpha" ? runtimeA : runtimeB,
    );
    await getHeartbeatReplyFromConfig(context("alpha"), undefined, a);
    await getHeartbeatReplyFromConfig(context("beta"), undefined, b);
    expect(bindRuntime.mock.calls.map(([runtime]) => runtime)).toEqual([runtimeA, runtimeB]);
  });

  it("H08 Concurrent wakes do not exchange runtime or config", async () => {
    const a = config("A");
    const b = config("B");
    const runtimeA = publication("alpha", a);
    const runtimeB = publication("beta", b);
    loadPublished.mockImplementation(async ({ agentId }: { agentId: string }) => {
      await Promise.resolve();
      return agentId === "alpha" ? runtimeA : runtimeB;
    });
    await Promise.all([
      getHeartbeatReplyFromConfig(context("alpha"), undefined, a),
      getHeartbeatReplyFromConfig(context("beta"), undefined, b),
    ]);
    expect(bindRuntime.mock.calls.map(([runtime]) => runtime)).toEqual([runtimeA, runtimeB]);
    expect(markFull).not.toHaveBeenCalled();
  });

  it("H09 Publication advance uses the new matching snapshot", async () => {
    const oldCfg = config("Old");
    const newCfg = config("New");
    loadPublished.mockResolvedValueOnce(publication("main", oldCfg));
    loadPublished.mockResolvedValueOnce(publication("main", newCfg));
    await getHeartbeatReplyFromConfig(context("main"), undefined, oldCfg);
    await getHeartbeatReplyFromConfig(context("main"), undefined, newCfg);
    expect(bindRuntime.mock.calls.map(([runtime]) => runtime.config)).toEqual([oldCfg, newCfg]);
    expect(markFull).not.toHaveBeenCalled();
  });

  it("H10 Aborted publication load never invokes reply and next wake succeeds", async () => {
    const cfg = config("Next");
    const controller = new AbortController();
    loadPublished.mockImplementationOnce(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      controller.abort();
      abortSignal?.throwIfAborted();
      return undefined;
    });
    await expect(
      getHeartbeatReplyFromConfig(
        context("main"),
        { abortSignal: controller.signal } as HeartbeatOptions,
        cfg,
      ),
    ).rejects.toThrow();
    expect(resolveReply).not.toHaveBeenCalled();
    await getHeartbeatReplyFromConfig(context("main"), undefined, cfg);
    expect(resolveReply).toHaveBeenCalledOnce();
  });
});
