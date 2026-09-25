// Focused owner-approved group invite persistence and notification regressions.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval, TlonSettingsStore } from "../settings.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

const notificationMock = vi.hoisted(() => vi.fn(async (_message: { text: string }) => {}));
vi.mock("../urbit/send.js", () => ({ sendDm: notificationMock }));

const approvalId = "group-100-abc";
const groupFlag = "group/~sampel-palnet/test";

function setup(options: { missingFlag?: boolean; original?: boolean } = {}) {
  vi.useFakeTimers();
  notificationMock.mockReset();
  notificationMock.mockImplementation(async () => {});
  const approval: PendingApproval = {
    id: approvalId,
    type: "group",
    requestingShip: "~zod",
    groupFlag: options.missingFlag ? undefined : groupFlag,
    timestamp: 100,
    originalMessage: options.original
      ? { messageId: "message-1", messageText: "hello", messageContent: "hello", timestamp: 100 }
      : undefined,
  };
  let pending: PendingApproval[] = [approval];
  let durablePending: PendingApproval[] = [approval];
  let failJoin = false;
  let failSave = false;
  const log = vi.fn();
  const error = vi.fn();
  const processApprovedMessage = vi.fn(async (_approval: PendingApproval) => {});
  const refreshWatchedChannels = vi.fn(async () => 0);
  const poke = vi.fn(
    async (request: {
      mark: string;
      json: { flag?: string; "put-entry"?: { "entry-key": string; value: unknown } };
    }) => {
      if (request.mark === "group-join") {
        if (failJoin) {
          throw new Error("join rejected");
        }
        return;
      }
      const entry = request.json["put-entry"];
      if (request.mark !== "settings-event" || entry?.["entry-key"] !== "pendingApprovals") {
        throw new Error("unexpected poke");
      }
      if (failSave) {
        throw new Error("pending save rejected");
      }
      durablePending = JSON.parse(entry.value as string) as PendingApproval[];
    },
  );
  const runtime = createTlonApprovalRuntime({
    api: { poke, scry: vi.fn(async () => []) } as unknown as Parameters<
      typeof createTlonApprovalRuntime
    >[0]["api"],
    runtime: { log, error } as unknown as Parameters<
      typeof createTlonApprovalRuntime
    >[0]["runtime"],
    botShipName: "~bot",
    getPendingApprovals: () => pending,
    setPendingApprovals: (value) => {
      pending = value;
    },
    getCurrentSettings: () => ({}) as TlonSettingsStore,
    setCurrentSettings: vi.fn(),
    getEffectiveDmAllowlist: () => [],
    setEffectiveDmAllowlist: vi.fn(),
    getEffectiveOwnerShip: () => "~owner",
    processApprovedMessage,
    refreshWatchedChannels,
  });
  return {
    approval,
    runtime,
    poke,
    log,
    error,
    processApprovedMessage,
    refreshWatchedChannels,
    setFailJoin: (value: boolean) => {
      failJoin = value;
    },
    setFailSave: (value: boolean) => {
      failSave = value;
    },
    get pending() {
      return pending;
    },
    get durablePending() {
      return durablePending;
    },
    notices: () => notificationMock.mock.calls.map(([message]) => message.text),
    joinCalls: () => poke.mock.calls.filter(([request]) => request.mark === "group-join"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Tlon group approval", () => {
  it("G01 confirms a saved successful join and removes pending", async () => {
    const state = setup();
    expect(await state.runtime.handleApprovalResponse(`approve ${approvalId}`)).toBe(true);
    expect(state.joinCalls()).toHaveLength(1);
    expect(state.joinCalls()[0]?.[0].json.flag).toBe(groupFlag);
    expect(state.pending).toEqual([]);
    expect(state.durablePending).toEqual([]);
    expect(state.notices()).toEqual([`Joined group ${groupFlag} after approval from ~zod.`]);
  });

  it("G02 retains pending and reports a rejected join", async () => {
    const state = setup();
    state.setFailJoin(true);
    expect(await state.runtime.handleApprovalResponse(`approve ${approvalId}`)).toBe(true);
    expect(state.joinCalls()).toHaveLength(1);
    expect(state.pending).toEqual([state.approval]);
    expect(state.durablePending).toEqual([state.approval]);
    expect(state.notices()).toEqual([expect.stringContaining("Failed to join group")]);
    expect(state.notices()[0]).not.toContain("Joined group");
  });

  it("G03 does not poke or clear an invite without a group flag", async () => {
    const state = setup({ missingFlag: true });
    expect(await state.runtime.handleApprovalResponse(`approve ${approvalId}`)).toBe(true);
    expect(state.joinCalls()).toHaveLength(0);
    expect(state.pending).toEqual([state.approval]);
    expect(state.durablePending).toEqual([state.approval]);
    expect(state.notices()[0]).toContain("request remains pending");
  });

  it("G04 distinguishes a successful join from failed pending persistence", async () => {
    const state = setup();
    state.setFailSave(true);
    expect(await state.runtime.handleApprovalResponse(`approve ${approvalId}`)).toBe(true);
    expect(state.joinCalls()).toHaveLength(1);
    expect(state.pending).toEqual([state.approval]);
    expect(state.durablePending).toEqual([state.approval]);
    expect(state.notices()[0]).toContain("may have succeeded");
    expect(state.notices()[0]).toContain("Verify group membership");
    expect(state.notices()[0]).not.toContain("Joined group");
  });

  it("G05 can retry the same pending ID after a rejected join", async () => {
    const state = setup();
    state.setFailJoin(true);
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    state.setFailJoin(false);
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    expect(state.joinCalls()).toHaveLength(2);
    expect(state.pending).toEqual([]);
    expect(state.durablePending).toEqual([]);
    expect(state.notices()[0]).toContain("Failed to join");
    expect(state.notices()[1]).toContain("Joined group");
  });

  it("G06 never replays an original message after a rejected group join", async () => {
    const state = setup({ original: true });
    state.setFailJoin(true);
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    expect(state.processApprovedMessage).not.toHaveBeenCalled();
    expect(state.pending).toEqual([state.approval]);
  });

  it("G07 treats delayed channel refresh rejection as post-join best effort", async () => {
    const state = setup();
    state.refreshWatchedChannels.mockRejectedValueOnce(new Error("refresh rejected"));
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.pending).toEqual([]);
    expect(state.durablePending).toEqual([]);
    expect(state.notices()[0]).toContain("Joined group");
    expect(state.log).toHaveBeenCalledWith(
      expect.stringContaining("Channel discovery after group join failed"),
    );
  });

  it("G08 does not claim discovered channels when refresh finds none", async () => {
    const state = setup();
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.refreshWatchedChannels).toHaveBeenCalledTimes(1);
    expect(state.notices()).toHaveLength(1);
    expect(state.log).not.toHaveBeenCalledWith(expect.stringContaining("Discovered 0"));
  });

  it("G09 logs failed owner notification without losing a rejected invite", async () => {
    const state = setup();
    state.setFailJoin(true);
    notificationMock.mockRejectedValueOnce(new Error("notification rejected"));
    await state.runtime.handleApprovalResponse(`approve ${approvalId}`);
    expect(state.pending).toEqual([state.approval]);
    expect(state.durablePending).toEqual([state.approval]);
    expect(state.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send notification"),
    );
  });

  it("G10 denies a group invite without a join poke", async () => {
    const state = setup();
    expect(await state.runtime.handleApprovalResponse(`deny ${approvalId}`)).toBe(true);
    expect(state.joinCalls()).toHaveLength(0);
    expect(state.pending).toEqual([]);
    expect(state.durablePending).toEqual([]);
    expect(state.notices()[0]).toContain("Denied group invite");
  });
});
