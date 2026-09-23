// File Transfer tests cover lazy node invoke policy plugin behavior.
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createLazyFileTransferNodeInvokePolicy } from "./lazy-node-invoke-policy.js";

function createPolicyContext(
  overrides: Partial<OpenClawPluginNodeInvokePolicyContext> = {},
): OpenClawPluginNodeInvokePolicyContext {
  return {
    nodeId: "node-1",
    command: "file.fetch",
    params: { path: "/tmp/a.txt" },
    config: {} as never,
    pluginConfig: {},
    node: {
      nodeId: "node-1",
      displayName: "Test Node",
      commands: ["file.fetch"],
    },
    client: null,
    invokeNode: vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    })),
    ...overrides,
  };
}

describe("lazy file-transfer node invoke policy", () => {
  it("exposes command metadata without loading the delegate", () => {
    const loadPolicy = vi.fn<() => Promise<OpenClawPluginNodeInvokePolicy>>();

    const policy = createLazyFileTransferNodeInvokePolicy(loadPolicy);

    expect(policy.commands).toEqual(["file.fetch", "dir.list", "dir.fetch", "file.write"]);
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it("loads and caches the delegate on first handle", async () => {
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    }));
    const delegateHandle = vi.fn<OpenClawPluginNodeInvokePolicy["handle"]>(async (ctx) => {
      await ctx.invokeNode();
      return { ok: true, payload: { delegated: true } };
    });
    const loadPolicy = vi.fn<() => Promise<OpenClawPluginNodeInvokePolicy>>(async () => ({
      commands: ["file.fetch"],
      handle: delegateHandle,
    }));
    const policy = createLazyFileTransferNodeInvokePolicy(loadPolicy);

    await expect(policy.handle(createPolicyContext({ invokeNode }))).resolves.toEqual({
      ok: true,
      payload: { delegated: true },
    });
    await expect(policy.handle(createPolicyContext({ invokeNode }))).resolves.toEqual({
      ok: true,
      payload: { delegated: true },
    });

    expect(loadPolicy).toHaveBeenCalledTimes(1);
    expect(delegateHandle).toHaveBeenCalledTimes(2);
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the delegate cannot load", async () => {
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    }));
    const policy = createLazyFileTransferNodeInvokePolicy(async () => {
      throw new Error("load failed");
    });

    await expect(policy.handle(createPolicyContext({ invokeNode }))).resolves.toMatchObject({
      ok: false,
      code: "PLUGIN_POLICY_UNAVAILABLE",
      unavailable: true,
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("does not rewrite delegate failures as load failures", async () => {
    const delegateError = new Error("delegate failed");
    const policy = createLazyFileTransferNodeInvokePolicy(async () => ({
      commands: ["file.fetch"],
      handle: async () => {
        throw delegateError;
      },
    }));

    await expect(policy.handle(createPolicyContext())).rejects.toBe(delegateError);
  });
});

describe("FILE-POLICY-R9-L01 rejected-load retry", () => {
  const delegate: OpenClawPluginNodeInvokePolicy = {
    commands: ["file.fetch"],
    handle: async () => ({ ok: true, payload: { delegated: true } }),
  };
  it.each([
    ["FILE-POLICY-R9-L01-01 first success is cached", ["ok", "ok"], 1],
    ["FILE-POLICY-R9-L01-02 repeated success does not reload", ["ok", "ok", "ok"], 1],
    ["FILE-POLICY-R9-L01-03 first failure is unavailable", ["fail"], 1],
    ["FILE-POLICY-R9-L01-04 failure then success retries", ["fail", "ok"], 2],
    ["FILE-POLICY-R9-L01-05 two failures then success retries twice", ["fail", "fail", "ok"], 3],
    ["FILE-POLICY-R9-L01-06 successful retry stays cached", ["fail", "ok", "ok"], 2],
    ["FILE-POLICY-R9-L01-07 three failures remain retriable", ["fail", "fail", "fail"], 3],
  ] as const)("%s", async (_name, outcomes, expectedLoads) => {
    let loads = 0;
    const policy = createLazyFileTransferNodeInvokePolicy(async () => {
      const outcome = outcomes[loads++];
      if (outcome === "fail") {
        throw new Error("transient load");
      }
      return delegate;
    });
    for (const outcome of outcomes) {
      const result = await policy.handle(createPolicyContext());
      expect(result.ok).toBe(outcome === "ok");
      if (outcome === "fail") {
        expect(result).toMatchObject({ code: "PLUGIN_POLICY_UNAVAILABLE", unavailable: true });
      }
    }
    expect(loads).toBe(expectedLoads);
  });

  it("FILE-POLICY-R9-L01-08 concurrent first calls share one in-flight loader", async () => {
    let complete!: (policy: OpenClawPluginNodeInvokePolicy) => void;
    const load = vi.fn(
      () =>
        new Promise<OpenClawPluginNodeInvokePolicy>((resolve) => {
          complete = resolve;
        }),
    );
    const policy = createLazyFileTransferNodeInvokePolicy(load);
    const first = policy.handle(createPolicyContext());
    const second = policy.handle(createPolicyContext());
    expect(load).toHaveBeenCalledTimes(1);
    complete(delegate);
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it("FILE-POLICY-R9-L01-09 concurrent rejection permits a later retry", async () => {
    let rejectLoad!: (error: Error) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OpenClawPluginNodeInvokePolicy>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      )
      .mockResolvedValue(delegate);
    const policy = createLazyFileTransferNodeInvokePolicy(load);
    const first = policy.handle(createPolicyContext());
    const second = policy.handle(createPolicyContext());
    rejectLoad(new Error("transient"));
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect((await policy.handle(createPolicyContext())).ok).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("FILE-POLICY-R9-L01-10 delegate rejection is not mistaken for load rejection", async () => {
    const failure = new Error("delegate failed");
    const load = vi.fn(async () => ({
      commands: ["file.fetch"],
      handle: async () => {
        throw failure;
      },
    }));
    const policy = createLazyFileTransferNodeInvokePolicy(load);
    await expect(policy.handle(createPolicyContext())).rejects.toBe(failure);
    await expect(policy.handle(createPolicyContext())).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
