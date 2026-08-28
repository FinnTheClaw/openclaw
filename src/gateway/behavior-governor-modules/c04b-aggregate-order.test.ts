import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "../behavior-governor-module-lifecycle.js";
import { createBuiltInBehaviorGovernorModules } from "../behavior-governor-module-plan.js";
import { prepareC04bAggregateOrderConfig } from "./c04b-aggregate-order-activation.js";
import {
  C04B_AGGREGATE_ORDER_MODULE_DIGEST,
  C04B_AGGREGATE_ORDER_MODULE_ID,
  C04B_AGGREGATE_ORDER_MODULE_VERSION,
} from "./c04b-aggregate-order.js";

function selection(mode: "shadow" | "enforce" = "enforce") {
  return {
    digest: C04B_AGGREGATE_ORDER_MODULE_DIGEST,
    id: C04B_AGGREGATE_ORDER_MODULE_ID,
    mode,
    version: C04B_AGGREGATE_ORDER_MODULE_VERSION,
  } as const;
}

function config(): OpenClawConfig {
  return {
    experimental: {
      behaviorGovernor: {
        enabled: true,
        mode: "enforce",
        modules: [selection()],
        secretRefs: {
          identityHmacKey: { source: "env", provider: "default", id: "id" },
          evidenceAdmissionKey: { source: "env", provider: "default", id: "evidence" },
          receiptSigningKey: { source: "env", provider: "default", id: "receipt" },
          ledgerSigningKey: { source: "env", provider: "default", id: "ledger" },
          deploymentIdentity: { source: "env", provider: "default", id: "deployment" },
        },
        agentLoop: {
          scopes: [{ sessionKey: "c04b-test" }],
          criteria: [
            { criterionId: "observe-a", description: "observe a" },
            { criterionId: "observe-b", description: "observe b" },
            { criterionId: "aggregate", description: "aggregate" },
          ],
          toolBindings: [],
          maxTurns: 8,
          expectedAssistantTextDigest: "a".repeat(64),
        },
      },
    },
  };
}

describe("selected C04B aggregate order module", () => {
  it("is inert when disabled and starts only the exact selected digest", async () => {
    const activate = vi.fn(async () => ({ close: vi.fn() }));
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({ activateC04bAggregateOrder: activate }),
    });

    await lifecycle.apply([]);
    expect(activate).not.toHaveBeenCalled();
    await lifecycle.close();

    const selected = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({ activateC04bAggregateOrder: activate }),
    });
    await selected.apply([selection()]);
    expect(activate).toHaveBeenCalledWith(selection());
    await selected.close();
  });

  it("fails closed for an absent or changed C04B digest", async () => {
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({
        activateC04bAggregateOrder: async () => ({ close: () => undefined }),
      }),
    });
    await expect(lifecycle.apply([{ ...selection(), digest: "b".repeat(64) }])).rejects.toThrow(
      "GOVERNOR_MODULE_DIGEST_MISMATCH",
    );
    await expect(lifecycle.apply([{ ...selection(), digest: undefined }])).rejects.toThrow(
      "GOVERNOR_MODULE_DIGEST_MISMATCH",
    );
  });

  it("makes aggregate depend on every observation before admission", () => {
    const prepared = prepareC04bAggregateOrderConfig(config(), "enforce");
    const governor = prepared.experimental!.behaviorGovernor!;
    if (!("enabled" in governor) || !governor.enabled) {
      throw new Error("test configuration unavailable");
    }
    expect(
      governor.agentLoop.criteria.find((item) => item.criterionId === "aggregate"),
    ).toMatchObject({
      dependsOnCriteria: ["observe-a", "observe-b"],
    });
  });

  it("preserves ordering across replay and rejects a changed selected plan until restart", async () => {
    const first = prepareC04bAggregateOrderConfig(config(), "enforce");
    const replayed = prepareC04bAggregateOrderConfig(first, "enforce");
    const aggregate = (source: OpenClawConfig) => {
      const governor = source.experimental!.behaviorGovernor!;
      return "enabled" in governor && governor.enabled
        ? governor.agentLoop.criteria.find((item) => item.criterionId === "aggregate")
        : undefined;
    };
    expect(aggregate(replayed)).toEqual(aggregate(first));

    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({
        activateC04bAggregateOrder: async () => ({ close: () => undefined }),
      }),
    });
    await lifecycle.apply([selection()]);
    await expect(lifecycle.apply([selection("shadow")])).rejects.toThrow(
      "GOVERNOR_MODULE_RESTART_REQUIRED",
    );
    await lifecycle.close();
  });

  it("retains lifecycle cleanup failures without activating an unrelated module", async () => {
    const close = vi.fn(() => {
      throw new Error("close failure");
    });
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: createBuiltInBehaviorGovernorModules({
        activateC04bAggregateOrder: async () => ({ close }),
      }),
    });
    await lifecycle.apply([selection()]);
    await expect(lifecycle.close()).rejects.toThrow("GOVERNOR_MODULE_CLOSE_FAILED");
    expect(close).toHaveBeenCalledOnce();
  });
});
