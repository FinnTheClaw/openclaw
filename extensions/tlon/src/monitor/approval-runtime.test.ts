import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TLON_PENDING_APPROVAL_LIMIT,
  type PendingApproval,
  type TlonSettingsStore,
} from "../settings.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

function createApproval(index: number): PendingApproval {
  return { id: `dm-${index}`, type: "dm", requestingShip: `~ship-${index}`, timestamp: index };
}

const message = { messageId: "m", messageText: "updated", messageContent: "updated", timestamp: 1 };

function createFixture(
  approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
    createApproval(index),
  ),
) {
  const state: Parameters<typeof createTlonApprovalRuntime>[0]["state"] = {
    pendingApprovals: approvals,
    currentSettings: {},
    effectiveDmAllowlist: [],
    effectiveOwnerShip: "~owner",
  };
  const poke = vi.fn().mockResolvedValue(undefined);
  const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
  const approvalRuntime = createTlonApprovalRuntime({
    api: { poke, scry: vi.fn().mockResolvedValue([]) },
    runtime,
    botShipName: "~bot",
    state,
    processApprovedMessage: vi.fn().mockResolvedValue(undefined),
    refreshWatchedChannels: vi.fn().mockResolvedValue(0),
  });
  return { approvals, poke, runtime, ...approvalRuntime, state };
}

describe("Tlon pending approval limit", () => {
  it.each([false, true])("bounds overflow notifications when delivery fails=%s", async (fails) => {
    const requests = fails ? 4 : 2;
    const notices = fails ? 3 : 1;
    const fixture = createFixture();
    if (fails) {
      fixture.poke.mockRejectedValue(new Error("owner unavailable"));
    }
    for (let index = 0; index < requests; index += 1) {
      const approval = createApproval(TLON_PENDING_APPROVAL_LIMIT + index);
      expect(await fixture.queueApprovalRequest(approval)).toBe(false);
    }
    expect(fixture.state.pendingApprovals).toEqual(fixture.approvals);
    expect(fixture.poke).toHaveBeenCalledTimes(notices);
    expect(fixture.runtime.error).toHaveBeenCalledTimes(fails ? notices : 0);
    if (!fails) {
      expect(fixture.poke).toHaveBeenCalledWith(
        expect.objectContaining({ app: "chat", mark: "chat-dm-action" }),
      );
      expect(fixture.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Pending approval limit reached"),
      );
    }
  });

  it("still updates an existing approval when the queue is full", async () => {
    const fixture = createFixture();
    const updated = {
      ...createApproval(0),
      messagePreview: "updated",
      originalMessage: message,
    } satisfies PendingApproval;

    expect(await fixture.queueApprovalRequest(updated)).toBe(true);
    expect(fixture.state.pendingApprovals).toHaveLength(TLON_PENDING_APPROVAL_LIMIT);
    expect(fixture.state.pendingApprovals[0]).toMatchObject({
      messagePreview: "updated",
      originalMessage: updated.originalMessage,
    });
    expect(fixture.poke).toHaveBeenCalledTimes(2);
  });

  it("moves verified provenance with the stored message when a request is updated", async () => {
    const fixture = createFixture();
    await fixture.queueApprovalRequest({
      ...createApproval(0),
      verifiedDirect: true,
      originalMessage: message,
    });
    expect(fixture.state.pendingApprovals[0]?.verifiedDirect).toBe(true);
    await fixture.queueApprovalRequest({ ...createApproval(0), originalMessage: message });
    expect(fixture.state.pendingApprovals[0]?.verifiedDirect).toBeUndefined();
  });
});

describe("Tlon approval targeting", () => {
  it("applies a bare decision when exactly one request is pending", async () => {
    const fixture = createFixture([createApproval(0)]);

    expect(await fixture.handleApprovalResponse("approve")).toBe(true);

    expect(fixture.state.effectiveDmAllowlist).toEqual(["~ship-0"]);
    expect(fixture.state.pendingApprovals).toEqual([]);
  });

  it("does not guess when a bare decision has multiple pending requests", async () => {
    const fixture = createFixture();

    expect(await fixture.handleApprovalResponse("approve")).toBe(true);

    expect(fixture.state.effectiveDmAllowlist).toEqual([]);
    expect(fixture.state.pendingApprovals).toEqual(fixture.approvals);
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("Multiple approvals are pending");
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("dm-0");
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("dm-99");
  });
});

// Regression cases for approval grant and pending-approval persistence.

const notificationMock = vi.hoisted(() => vi.fn(async (_message: { text: string }) => {}));
const notificationMode = vi.hoisted(() => ({ capture: false }));
vi.mock("../urbit/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../urbit/send.js")>();
  return {
    ...actual,
    sendDm: (params: Parameters<typeof actual.sendDm>[0]) =>
      notificationMode.capture ? notificationMock(params) : actual.sendDm(params),
  };
});
afterEach(() => {
  notificationMode.capture = false;
});

type AccessType = "dm" | "channel";
type Scenario = {
  name: string;
  type: AccessType;
  grantFails: boolean;
  removalFails: boolean;
  original: boolean;
  concurrentUpdate?: boolean;
};

const nest = "chat/~sampel-palnet/test";
const ship = "~zod";
const cases: Scenario[] = [
  {
    name: "DM grant persists, processes original, and clears pending",
    type: "dm",
    grantFails: false,
    removalFails: false,
    original: true,
  },
  {
    name: "channel grant persists, processes original, and clears pending",
    type: "channel",
    grantFails: false,
    removalFails: false,
    original: true,
  },
  {
    name: "DM grant rejection retains pending even when deletion would succeed",
    type: "dm",
    grantFails: true,
    removalFails: false,
    original: true,
  },
  {
    name: "channel grant rejection retains pending even when deletion would succeed",
    type: "channel",
    grantFails: true,
    removalFails: false,
    original: true,
  },
  {
    name: "DM grant keeps another ship added while the poke is in flight",
    type: "dm",
    grantFails: false,
    removalFails: false,
    original: true,
    concurrentUpdate: true,
  },
  {
    name: "channel grant keeps concurrent rules and channel mode",
    type: "channel",
    grantFails: false,
    removalFails: false,
    original: true,
    concurrentUpdate: true,
  },
  {
    name: "DM grant rejection without original message retains pending",
    type: "dm",
    grantFails: true,
    removalFails: false,
    original: false,
  },
  {
    name: "channel grant rejection without original message retains pending",
    type: "channel",
    grantFails: true,
    removalFails: false,
    original: false,
  },
  {
    name: "DM pending-removal rejection is distinct after saved grant",
    type: "dm",
    grantFails: false,
    removalFails: true,
    original: true,
  },
  {
    name: "channel pending-removal rejection is distinct after saved grant",
    type: "channel",
    grantFails: false,
    removalFails: true,
    original: true,
  },
];

function setup(scenario: Scenario) {
  notificationMode.capture = true;
  notificationMock.mockClear();
  const approval: PendingApproval = {
    id: `${scenario.type}-100-abc`,
    type: scenario.type,
    requestingShip: ship,
    channelNest: scenario.type === "channel" ? nest : undefined,
    timestamp: 100,
    verifiedDirect: true,
    originalMessage: scenario.original
      ? { messageId: "message-1", messageText: "hello", messageContent: "hello", timestamp: 100 }
      : undefined,
  };
  let pending: PendingApproval[] = [approval];
  let dmAllowlist: string[] = [];
  let settings: TlonSettingsStore = {
    channelRules: { [nest]: { mode: "restricted", allowedShips: [] } },
  };
  const durable = {
    dmAllowlist: [] as string[],
    channelRules: { [nest]: { mode: "restricted", allowedShips: [] as string[] } },
    pendingApprovals: [approval] as PendingApproval[],
  };
  const events: string[] = [];
  const processor = vi.fn(async (_approval: PendingApproval) => {});
  const poke = vi.fn(
    async (request: { json: { "put-entry"?: { "entry-key": string; value: unknown } } }) => {
      const entry = request.json["put-entry"];
      if (!entry) {
        throw new Error("unexpected poke");
      }
      events.push(entry["entry-key"]);
      if (entry["entry-key"] === "dmAllowlist") {
        if (scenario.grantFails) {
          throw new Error("grant write rejected");
        }
        durable.dmAllowlist = entry.value as string[];
        if (scenario.concurrentUpdate) {
          dmAllowlist = ["~other"];
        }
      } else if (entry["entry-key"] === "channelRules") {
        if (scenario.grantFails) {
          throw new Error("grant write rejected");
        }
        durable.channelRules = JSON.parse(entry.value as string) as typeof durable.channelRules;
        if (scenario.concurrentUpdate) {
          settings = {
            ...settings,
            channelRules: {
              ...settings.channelRules,
              [nest]: { mode: "open", allowedShips: ["~other"] },
              "chat/~other/parallel": { mode: "restricted", allowedShips: ["~other"] },
            },
          };
        }
      } else if (entry["entry-key"] === "pendingApprovals") {
        if (scenario.removalFails) {
          throw new Error("pending removal rejected");
        }
        durable.pendingApprovals = JSON.parse(entry.value as string) as PendingApproval[];
      } else {
        throw new Error(`unexpected entry: ${entry["entry-key"]}`);
      }
    },
  );
  const runtime = createTlonApprovalRuntime({
    api: { poke, scry: vi.fn(async () => []) } as unknown as Parameters<
      typeof createTlonApprovalRuntime
    >[0]["api"],
    runtime: { log: vi.fn(), error: vi.fn() } as unknown as Parameters<
      typeof createTlonApprovalRuntime
    >[0]["runtime"],
    botShipName: "~bot",
    state: {
      get pendingApprovals() {
        return pending;
      },
      set pendingApprovals(value) {
        pending = value;
      },
      get currentSettings() {
        return settings;
      },
      set currentSettings(value) {
        settings = value;
      },
      get effectiveDmAllowlist() {
        return dmAllowlist;
      },
      set effectiveDmAllowlist(value) {
        dmAllowlist = value;
      },
      effectiveOwnerShip: "~owner",
    },
    processApprovedMessage: processor,
    refreshWatchedChannels: vi.fn(async () => 0),
  });
  return {
    approval,
    durable,
    events,
    processor,
    runtime,
    get pending() {
      return pending;
    },
    get dmAllowlist() {
      return dmAllowlist;
    },
    get settings() {
      return settings;
    },
    notifications: () => notificationMock.mock.calls.map(([message]) => String(message.text)),
  };
}

describe("Tlon approval grant persistence", () => {
  it.each(cases)("$name", async (scenario) => {
    const state = setup(scenario);
    expect(await state.runtime.handleApprovalResponse(`approve ${state.approval.id}`)).toBe(true);
    const grantKey = scenario.type === "dm" ? "dmAllowlist" : "channelRules";
    expect(state.events[0]).toBe(grantKey);
    const grantInMemory =
      scenario.type === "dm"
        ? state.dmAllowlist.includes(ship)
        : state.settings.channelRules?.[nest]?.allowedShips?.includes(ship);
    const grantAfterReload =
      scenario.type === "dm"
        ? state.durable.dmAllowlist.includes(ship)
        : state.durable.channelRules[nest].allowedShips.includes(ship);
    const notices = state.notifications();
    expect(notices).toHaveLength(1);

    if (scenario.grantFails) {
      expect(state.events).toEqual([grantKey]);
      expect(state.processor).not.toHaveBeenCalled();
      expect(grantInMemory).toBe(false);
      expect(grantAfterReload).toBe(false);
      expect(state.pending).toEqual([state.approval]);
      expect(state.durable.pendingApprovals).toEqual([state.approval]);
      expect(notices[0]).toContain("access grant was not saved");
      expect(notices[0]).not.toContain("They can now");
    } else {
      expect(state.events).toEqual([grantKey, "pendingApprovals"]);
      expect(grantInMemory).toBe(true);
      expect(grantAfterReload).toBe(true);
      expect(state.processor).toHaveBeenCalledTimes(scenario.original ? 1 : 0);
      if (scenario.concurrentUpdate) {
        if (scenario.type === "dm") {
          expect(state.dmAllowlist).toContain("~other");
        } else {
          expect(state.settings.channelRules?.[nest]).toMatchObject({
            mode: "open",
            allowedShips: ["~other", ship],
          });
          expect(state.settings.channelRules?.["chat/~other/parallel"]).toEqual({
            mode: "restricted",
            allowedShips: ["~other"],
          });
        }
      }
      if (scenario.removalFails) {
        expect(state.pending).toEqual([state.approval]);
        expect(state.durable.pendingApprovals).toEqual([state.approval]);
        expect(notices[0]).toContain("grant");
        expect(notices[0]).toContain("pending request could not be cleared");
        expect(notices[0]).toContain("do not retry until it is cleared");
        expect(notices[0]).not.toContain("They can now");
      } else {
        expect(state.pending).toEqual([]);
        expect(state.durable.pendingApprovals).toEqual([]);
        expect(notices[0]).toContain(
          scenario.type === "dm" ? "Approved DM access" : "They can now interact",
        );
      }
    }
  });
});

describe("L07-F24 native block acknowledgement", () => {
  it.each([
    { command: "block", rejected: true },
    { command: "block dm-1", rejected: true },
    { command: "block", rejected: false },
    { command: "block dm-1", rejected: false },
  ])("retains pending only on rejected $command ($rejected)", async ({ command, rejected }) => {
    notificationMode.capture = true;
    notificationMock.mockClear();
    const approval = createApproval(1);
    let pending = [approval];
    let durable = structuredClone(pending);
    const events: string[] = [];
    const poke = vi.fn(
      async (request: {
        mark: string;
        json: { ship?: string; "put-entry"?: { "entry-key": string; value: string } };
      }) => {
        if (request.mark === "chat-block-ship") {
          expect(request.json.ship).toBe(approval.requestingShip);
          events.push("native-block");
          if (rejected) {
            throw new Error("synthetic native block rejected");
          }
          return;
        }
        const entry = request.json["put-entry"];
        if (entry?.["entry-key"] !== "pendingApprovals") {
          throw new Error("unexpected settings mutation");
        }
        events.push("persist-pending");
        durable = JSON.parse(entry.value) as PendingApproval[];
      },
    );
    const processor = vi.fn(async () => {});
    const runtime = createTlonApprovalRuntime({
      api: { poke, scry: vi.fn(async () => []) } as unknown as Parameters<
        typeof createTlonApprovalRuntime
      >[0]["api"],
      runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
      botShipName: "~bot",
      getPendingApprovals: () => pending,
      setPendingApprovals: (value) => {
        pending = value;
      },
      getCurrentSettings: () => ({}),
      setCurrentSettings: vi.fn(),
      getEffectiveDmAllowlist: () => [],
      setEffectiveDmAllowlist: vi.fn(),
      getEffectiveOwnerShip: () => "~owner",
      processApprovedMessage: processor,
      refreshWatchedChannels: vi.fn(async () => 0),
    });
    const handled = await runtime.handleApprovalResponse(command);
    const notices = notificationMock.mock.calls.map(([message]) => message.text);
    const observed = {
      handled,
      pending,
      durable,
      events,
      noticeCount: notices.length,
      failureReported: notices.some((text) => /failed to block/i.test(text)),
      successReported: notices.some((text) => /^Blocked /i.test(text)),
      processorCalls: processor.mock.calls.length,
    };
    expect(observed).toEqual({
      handled: true,
      pending: rejected ? [approval] : [],
      durable: rejected ? [approval] : [],
      events: rejected ? ["native-block"] : ["native-block", "persist-pending"],
      noticeCount: 1,
      failureReported: rejected,
      successReported: !rejected,
      processorCalls: 0,
    });
  });
});
