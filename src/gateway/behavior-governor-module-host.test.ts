import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  clearSigner: vi.fn(),
  closeRuntime: vi.fn(),
  fence: vi.fn(),
  installSigner: vi.fn(),
}));

vi.mock("../agents/subagent-gateway-acceptance-receipt-recovery.sqlite.js", () => ({
  fencePriorGatewayAcceptanceReceipts: state.fence,
}));
vi.mock("../agents/subagent-gateway-acceptance-receipt-runtime.js", () => ({
  clearGatewayAcceptanceReceiptSigner: state.clearSigner,
  installGatewayAcceptanceReceiptSigner: state.installSigner,
}));
vi.mock("../infra/agent-events.js", () => ({ getAgentEventLifecycleGeneration: () => 7 }));
vi.mock("../secrets/runtime-module-host.js", () => ({
  prepareBehaviorGovernorModuleHostSnapshot: vi.fn(async () => ({
    generation: 3,
    stateDir: "/tmp/state",
    secrets: {
      identityHmacKey: "identity",
      evidenceAdmissionKey: "evidence",
      evidenceAdmissionKeyId: "key-id",
      receiptSigningKey: "receipt",
      ledgerSigningKey: "ledger",
      deploymentIdentity: "deployment",
    },
  })),
}));
vi.mock("../security/governor-host-bootstrap.js", () => ({
  createGovernorHostRuntimeIfEnabled: vi.fn(() => ({
    adapter: { controller: { store: {} } },
    freeze: vi.fn(),
    close: state.closeRuntime,
  })),
}));
vi.mock("./behavior-governor-module-host-descriptor.js", () => ({
  loadGatewayBehaviorGovernorModuleHostDescriptor: vi.fn(async () => ({
    schema: "openclaw.behavior-governor-module-host/v1",
    secretRefs: {},
    capabilities: {},
    integrations: {},
  })),
}));

import {
  createGatewayBehaviorGovernorModuleHostProvider,
  takeGatewayBehaviorGovernorModuleHostAcquisitionCleanup,
} from "./behavior-governor-module-host.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";

describe("gateway behavior governor module host acquisition rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears an installed signer after fence and runtime-close failures and retains retry ownership", async () => {
    const fenceError = new Error("fence failed");
    const closeError = new Error("runtime close failed");
    state.fence.mockImplementationOnce(() => {
      throw fenceError;
    });
    state.closeRuntime
      .mockImplementationOnce(() => {
        throw closeError;
      })
      .mockImplementationOnce(() => {
        throw closeError;
      })
      .mockImplementationOnce(() => undefined);

    const provider = createGatewayBehaviorGovernorModuleHostProvider("/managed/descriptor.json");
    let acquisitionError: unknown;
    try {
      await provider.acquire({ gatewayConfig: {} });
    } catch (error) {
      acquisitionError = error;
    }

    expect(state.installSigner).toHaveBeenCalledOnce();
    expect(state.clearSigner).toHaveBeenCalledOnce();
    expect(acquisitionError).toBeInstanceOf(AggregateError);
    expect((acquisitionError as AggregateError).cause).toBe(fenceError);
    expect((acquisitionError as AggregateError).errors).toEqual([fenceError, closeError]);

    const cleanup = takeGatewayBehaviorGovernorModuleHostAcquisitionCleanup(acquisitionError);
    expect(cleanup).toBeDefined();
    expect(() => cleanup?.close()).toThrow(closeError);
    expect(state.clearSigner).toHaveBeenCalledTimes(2);
    cleanup?.close();
    expect(state.closeRuntime).toHaveBeenCalledTimes(3);
    expect(state.clearSigner).toHaveBeenCalledTimes(3);
  });

  it("retains failed acquisition cleanup in the lifecycle until shutdown retry succeeds", async () => {
    state.fence.mockImplementationOnce(() => {
      throw new Error("fence failed");
    });
    state.closeRuntime
      .mockImplementationOnce(() => {
        throw new Error("initial close failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("rollback retry failed");
      })
      .mockImplementationOnce(() => undefined);
    const hostProvider = createGatewayBehaviorGovernorModuleHostProvider(
      "/managed/descriptor.json",
    );
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      hostProvider,
      catalog: [
        {
          id: "c02",
          version: "1",
          supportedModes: ["enforce"],
          qualifiedModes: ["enforce"],
          dependencies: [],
          durableBoundaryIds: [],
          load: vi.fn(),
        },
      ],
    });

    await expect(
      lifecycle.apply([{ id: "c02", version: "1", mode: "enforce" }], {}),
    ).rejects.toThrow("GOVERNOR_MODULE_STARTUP_CLEANUP_FAILED");
    expect(state.clearSigner).toHaveBeenCalledTimes(2);
    await lifecycle.close();
    expect(state.closeRuntime).toHaveBeenCalledTimes(3);
    expect(state.clearSigner).toHaveBeenCalledTimes(3);
  });

  it("binds a leaf-owned exact registration without feature policy in the neutral host", async () => {
    const close = vi.fn();
    const bind = vi.fn(() => ({ wrap: vi.fn(), close }));
    const provider = createGatewayBehaviorGovernorModuleHostProvider("/managed/descriptor.json");
    const lease = await provider.acquire({ gatewayConfig: {} });
    lease.capability.forActivation({ id: "fixture-module", version: "v1", mode: "enforce" }, {
      id: "fixture-module",
      version: "v1",
      bind,
    } as never);
    expect(bind).toHaveBeenCalledOnce();
    lease.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
