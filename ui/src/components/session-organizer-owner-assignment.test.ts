/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import type { SessionActionHost } from "./session-organizer-batch-mutations.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";
import * as organizerOperations from "./session-organizer-operations.runtime.ts";
import { assignSessionOwner } from "./session-organizer-operations.runtime.ts";

function createHarness() {
  let current = true;
  let sessionError: string | null = null;
  let settleAssignment: ((result: null) => void) | undefined;
  const assignOwner = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        settleAssignment = resolve;
      }),
  );
  const publishSessionMutationError = vi.fn();
  const snapshot = {
    client: {},
    phase: "connected",
    hello: gatewayHelloForMethods(["sessions.assignOwner"], ["operator.write"]),
  } as ApplicationGatewaySnapshot;
  const scope = {
    gateway: { snapshot },
    sessions: {
      assignOwner,
      get state() {
        return { error: sessionError };
      },
    } as unknown as SessionCapability,
    selectedAgentId: "main",
  } as SidebarSessionMutationScope;
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
    },
  } as unknown as SessionActionHost;
  const session = {
    key: "agent:main:owner-proof",
  };
  return {
    assignOwner,
    host,
    publishSessionMutationError,
    retire: () => {
      current = false;
    },
    scope,
    session,
    setError: (error: string) => {
      sessionError = error;
    },
    settle: () => settleAssignment?.(null),
  };
}

describe("assignSessionOwner", () => {
  it.each([
    { name: "retired during controller load", delayed: true, current: false },
    { name: "current after controller load", delayed: true, current: true },
    { name: "retired before direct operation", delayed: false, current: false },
  ])("abandons owner assignment before delayed dispatch ($name)", async (row) => {
    const harness = createHarness();
    harness.assignOwner.mockResolvedValue(null);
    const owner = { type: "human", id: "profile-ada" } as const;
    const snapshot = harness.scope.gateway.snapshot;
    const beginSessionMutation = vi.fn(() => harness.scope);
    let releaseOperations: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    let callsBeforeRelease: number | undefined;
    try {
      if (row.delayed) {
        const operationsLoad = new Promise<typeof organizerOperations>((resolve) => {
          releaseOperations = () => resolve(organizerOperations);
        });
        const controller = new SessionOrganizerController({
          ...harness.host,
          sessionData: { ...harness.host.sessionData, beginSessionMutation },
        } as never);
        Object.assign(controller, { operationsLoad });
        pending = controller.assignSessionOwner(harness.session, owner);
        callsBeforeRelease = harness.assignOwner.mock.calls.length;
        if (!row.current) {
          harness.retire();
        }
        releaseOperations?.();
      } else {
        harness.retire();
        pending = assignSessionOwner(harness.host, harness.session, owner, harness.scope);
      }
      await pending;
      const facts = {
        assignmentCalls: [...harness.assignOwner.mock.calls],
        publishedErrors: [...harness.publishSessionMutationError.mock.calls],
        capturedScopes: beginSessionMutation.mock.results.map((result) => result.value),
        sameSnapshot: harness.scope.gateway.snapshot === snapshot,
        phase: harness.scope.gateway.snapshot.phase,
        callsBeforeRelease,
      };

      expect
        .soft(facts.assignmentCalls)
        .toEqual(row.current ? [[harness.session.key, owner, { agentId: "main" }]] : []);
      expect.soft(facts.publishedErrors).toEqual([]);
      expect.soft(facts.capturedScopes).toEqual(row.delayed ? [harness.scope] : []);
      expect.soft(facts.sameSnapshot).toBe(true);
      expect.soft(facts.phase).toBe("connected");
      if (row.delayed) {
        expect.soft(facts.callsBeforeRelease).toBe(0);
      }
    } finally {
      releaseOperations?.();
      harness.settle();
      await pending;
    }
  });

  it("publishes a current capability rejection at the action surface", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    harness.setError("Owner assignment rejected.");
    harness.settle();
    await pending;

    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Owner assignment rejected.",
    );
  });

  it("keeps a retired assignment rejection silent", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    harness.setError("Retired assignment rejection.");
    harness.retire();
    harness.settle();
    await pending;

    expect(harness.assignOwner).toHaveBeenCalledOnce();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
  });
});
