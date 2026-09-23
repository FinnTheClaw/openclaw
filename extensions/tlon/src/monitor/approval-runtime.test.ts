// Regression cases for approval grant and pending-approval persistence.
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval, TlonSettingsStore } from "../settings.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

const notificationMock = vi.hoisted(() => vi.fn(async (_message: { text: string }) => {}));
vi.mock("../urbit/send.js", () => ({ sendDm: notificationMock }));

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
  notificationMock.mockClear();
  const approval: PendingApproval = {
    id: `${scenario.type}-100-abc`,
    type: scenario.type,
    requestingShip: ship,
    channelNest: scenario.type === "channel" ? nest : undefined,
    timestamp: 100,
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
    getPendingApprovals: () => pending,
    setPendingApprovals: (value) => {
      pending = value;
    },
    getCurrentSettings: () => settings,
    setCurrentSettings: (value) => {
      settings = value;
    },
    getEffectiveDmAllowlist: () => dmAllowlist,
    setEffectiveDmAllowlist: (value) => {
      dmAllowlist = value;
    },
    getEffectiveOwnerShip: () => "~owner",
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
