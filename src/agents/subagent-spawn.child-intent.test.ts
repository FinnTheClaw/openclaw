import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  markDispatchingMock: vi.fn(),
  markUnknownMock: vi.fn(),
  adoptChildIntentMock: vi.fn(),
  abandonChildIntentMock: vi.fn(),
  reserveChildIntentMock: vi.fn(),
  releaseChildIntentMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  config: {} as Record<string, unknown>,
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: () => void;

function setupReservationMock() {
  const reservations = new Map<
    string,
    {
      childSessionKey: string;
      runId: string;
      requesterSessionKey: string;
      durableReceiptRequired?: boolean;
    }
  >();
  hoisted.reserveChildIntentMock.mockImplementation(
    (input: {
      childIntentKey: string;
      childSessionKey: string;
      reservationRunId: string;
      requesterSessionKey: string;
      maxActiveChildren?: number;
      durableReceiptRequired?: boolean;
    }) => {
      const existing = reservations.get(input.childIntentKey);
      if (existing) {
        return {
          disposition: "duplicate",
          childIntentKey: input.childIntentKey,
          childSessionKey: existing.childSessionKey,
          reservationRunId: existing.runId,
          existingRunId: existing.runId,
          durableReceiptRequired: existing.durableReceiptRequired,
        };
      }
      const active = [...reservations.values()].filter(
        (entry) => entry.requesterSessionKey === input.requesterSessionKey,
      ).length;
      if (typeof input.maxActiveChildren === "number" && active >= input.maxActiveChildren) {
        throw new Error(
          `sessions_spawn has reached max active children for this session (${active}/${input.maxActiveChildren})`,
        );
      }
      reservations.set(input.childIntentKey, {
        childSessionKey: input.childSessionKey,
        runId: "run-1",
        requesterSessionKey: input.requesterSessionKey,
        durableReceiptRequired: input.durableReceiptRequired,
      });
      return {
        disposition: "owner",
        childIntentKey: input.childIntentKey,
        childSessionKey: input.childSessionKey,
        reservationRunId: input.reservationRunId,
        reservationToken: "reservation-token",
        durableReceiptRequired: input.durableReceiptRequired,
      };
    },
  );
  return reservations;
}

describe("host-owned child intent admission", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      markSubagentChildIntentDispatchingMock: hoisted.markDispatchingMock,
      markSubagentChildIntentUnknownMock: hoisted.markUnknownMock,
      adoptSubagentChildIntentMock: hoisted.adoptChildIntentMock,
      abandonUnresolvedSubagentChildIntentMock: hoisted.abandonChildIntentMock,
      reserveSubagentChildIntentMock: hoisted.reserveChildIntentMock,
      releaseSubagentChildIntentMock: hoisted.releaseChildIntentMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      getRuntimeConfig: () => hoisted.config,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.markDispatchingMock.mockReset();
    hoisted.markUnknownMock.mockReset();
    hoisted.adoptChildIntentMock.mockReset();
    hoisted.abandonChildIntentMock.mockReset();
    hoisted.reserveChildIntentMock.mockReset();
    hoisted.releaseChildIntentMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.resolveAgentConfigMock.mockReset();
    hoisted.resolveAgentConfigMock.mockReturnValue(undefined);
    hoisted.config = createSubagentSpawnTestConfig(os.tmpdir());
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    setupReservationMock();
  });

  it("dedupes repeated semantic proposals before a second physical child dispatch", async () => {
    const request = {
      task: "inspect the same bounded coding shard",
      subagentRole: "orchestrator" as const,
    };
    const first = await spawnSubagentDirect(request, {
      agentSessionKey: "agent:main:main",
    });
    const second = await spawnSubagentDirect(request, {
      agentSessionKey: "agent:main:main",
    });

    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({
      status: "accepted",
      childSessionKey: first.childSessionKey,
      runId: "run-1",
    });
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent"),
    ).toHaveLength(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.reserveChildIntentMock).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct explicit operation keys as distinct children", async () => {
    const base = {
      task: "perform the same-shaped independent shard",
    };
    const first = await spawnSubagentDirect(
      { ...base, idempotencyKey: "slot-a" },
      {
        agentSessionKey: "agent:main:main",
      },
    );
    const second = await spawnSubagentDirect(
      { ...base, idempotencyKey: "slot-b" },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(second.childSessionKey).not.toBe(first.childSessionKey);
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent"),
    ).toHaveLength(2);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(2);
  });

  it("carries explicit governed mode and capability through the real child RPC envelope", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "governed child transport",
        idempotencyKey: "governed-child-transport",
        childLifecycleMode: "governed",
      },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => call.method === "child.dispatch" || call.method === "agent",
    );
    expect(agentCall?.[0].params).toMatchObject({
      childIntentReceiptMode: "governed",
      childIntentCapability: "sessions_spawn",
    });
    expect(hoisted.reserveChildIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({ durableReceiptRequired: true }),
    );
  });

  it("counts proxy-owned children against the controller max, not completion aliases", async () => {
    hoisted.config = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 1 },
        },
      },
    });
    const first = await spawnSubagentDirect(
      { task: "proxy child one", idempotencyKey: "proxy-one" },
      {
        agentSessionKey: "agent:main:main",
        completionOwnerKey: "agent:other:one",
      },
    );
    const second = await spawnSubagentDirect(
      { task: "proxy child two", idempotencyKey: "proxy-two" },
      {
        agentSessionKey: "agent:main:main",
        completionOwnerKey: "agent:other:two",
      },
    );

    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({ status: "forbidden" });
    expect(second.status === "forbidden" ? second.error : "").toContain("max active children");
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent"),
    ).toHaveLength(1);
  });

  it("durably fences a provider acceptance when registration fails", async () => {
    hoisted.registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registration boundary failure");
    });
    const request = {
      task: "one child whose registration crashes after provider acceptance",
      idempotencyKey: "registration-crash-once",
    };

    const first = await spawnSubagentDirect(request, {
      agentSessionKey: "agent:main:main",
    });
    const second = await spawnSubagentDirect(request, {
      agentSessionKey: "agent:main:main",
    });

    expect(first.status).toBe("error");
    expect(second).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(hoisted.markUnknownMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerRunId: "run-1" }),
    );
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent"),
    ).toHaveLength(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("adopts an accepted child after restart instead of dispatching twice", async () => {
    let reservationCalls = 0;
    hoisted.reserveChildIntentMock.mockImplementation((input: Record<string, unknown>) => {
      reservationCalls += 1;
      if (reservationCalls === 1) {
        return {
          disposition: "owner",
          childIntentKey: input.childIntentKey,
          childSessionKey: input.childSessionKey,
          reservationRunId: input.reservationRunId,
          reservationToken: "durable-token",
        };
      }
      return {
        disposition: "duplicate",
        childIntentKey: input.childIntentKey,
        childSessionKey: input.childSessionKey,
        reservationRunId: "provider-run-1",
        existingRunId: "provider-run-1",
        dispatchState: "unknown",
        reservationToken: "durable-token",
      };
    });
    hoisted.callGatewayMock.mockImplementation(async ({ method }: { method?: string }) => {
      if (method === "agent") {
        return { runId: "provider-run-1", status: "accepted" };
      }
      if (method === "agent.wait") {
        return { runId: "provider-run-1", status: "ok", providerStarted: true };
      }
      return { ok: true };
    });
    hoisted.registerSubagentRunMock.mockImplementationOnce(() => {
      throw new Error("crash after provider acceptance");
    });
    hoisted.adoptChildIntentMock.mockReturnValue(true);

    const request = {
      task: "recover one accepted child",
      idempotencyKey: "recover-accepted-child",
    };
    const first = await spawnSubagentDirect(request, { agentSessionKey: "agent:main:main" });
    const recovered = await spawnSubagentDirect(request, { agentSessionKey: "agent:main:main" });

    expect(first.status).toBe("error");
    expect(recovered).toMatchObject({ status: "accepted", runId: "provider-run-1" });
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent"),
    ).toHaveLength(1);
    expect(
      hoisted.callGatewayMock.mock.calls.filter(([call]) => call.method === "agent.wait"),
    ).toHaveLength(1);
    expect(hoisted.adoptChildIntentMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(2);
  });
});
