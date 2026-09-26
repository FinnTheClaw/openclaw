// Controlled scry inputs exercise the real Tlon settings manager load boundary.
import { describe, expect, it } from "vitest";
import { createSettingsManager, type PendingApproval, type TlonSettingsStore } from "./settings.js";
import type { UrbitSSEClient } from "./urbit/sse-client.js";

const originalMessage = (text: string, content: unknown = {}) => ({
  messageId: "fixture-message",
  messageText: text,
  messageContent: content,
  timestamp: 1,
});

function approval(id: string, extra: Partial<PendingApproval> = {}): PendingApproval {
  return { id, type: "dm", requestingShip: "~fixture", timestamp: 1, ...extra };
}

type Case = {
  id: string;
  name: string;
  loads: unknown[];
  counts: number[];
  hidden: string[];
  check: (states: [TlonSettingsStore, ...TlonSettingsStore[]]) => void;
};

const cases: Case[] = [
  {
    id: "CP60-TL01",
    name: "pending original message text",
    loads: [
      {
        pendingApprovals: [
          approval("one", { originalMessage: originalMessage("TL01_private_text") }),
        ],
      },
    ],
    counts: [1],
    hidden: ["TL01_private_text"],
    check: ([state]) =>
      expect(state.pendingApprovals?.[0]?.originalMessage?.messageText).toBe("TL01_private_text"),
  },
  {
    id: "CP60-TL02",
    name: "nested original message content",
    loads: [
      {
        pendingApprovals: [
          approval("two", {
            originalMessage: originalMessage("ordinary", {
              blocks: [{ text: "TL02_nested_secret" }],
            }),
          }),
        ],
      },
    ],
    counts: [1],
    hidden: ["TL02_nested_secret"],
    check: ([state]) =>
      expect(state.pendingApprovals?.[0]?.originalMessage?.messageContent).toEqual({
        blocks: [{ text: "TL02_nested_secret" }],
      }),
  },
  {
    id: "CP60-TL03",
    name: "pending message preview",
    loads: [{ pendingApprovals: [approval("three", { messagePreview: "TL03_private_preview" })] }],
    counts: [1],
    hidden: ["TL03_private_preview"],
    check: ([state]) =>
      expect(state.pendingApprovals?.[0]?.messagePreview).toBe("TL03_private_preview"),
  },
  {
    id: "CP60-TL04",
    name: "JSON-string pending approvals",
    loads: [
      {
        pendingApprovals: JSON.stringify([
          approval("four", { originalMessage: originalMessage("TL04_json_message") }),
        ]),
      },
    ],
    counts: [1],
    hidden: ["TL04_json_message"],
    check: ([state]) =>
      expect(state.pendingApprovals?.[0]?.originalMessage?.messageText).toBe("TL04_json_message"),
  },
  {
    id: "CP60-TL05",
    name: "multiple pending approvals",
    loads: [
      {
        pendingApprovals: [
          approval("five-a", { messagePreview: "TL05_first_preview" }),
          approval("five-b", { originalMessage: originalMessage("TL05_second_text") }),
        ],
      },
    ],
    counts: [2],
    hidden: ["TL05_first_preview", "TL05_second_text"],
    check: ([state]) => expect(state.pendingApprovals).toHaveLength(2),
  },
  {
    id: "CP60-TL06",
    name: "unrelated DM and channel identifiers",
    loads: [{ dmAllowlist: ["~TL06_private_dm"], groupChannels: ["TL06_private_channel"] }],
    counts: [0],
    hidden: ["~TL06_private_dm", "TL06_private_channel"],
    check: ([state]) => {
      expect(state.dmAllowlist).toEqual(["~TL06_private_dm"]);
      expect(state.groupChannels).toEqual(["TL06_private_channel"]);
    },
  },
  {
    id: "CP60-TL07",
    name: "owner and group authorization identifiers",
    loads: [
      {
        ownerShip: "~TL07_owner",
        defaultAuthorizedShips: ["~TL07_authorized"],
        groupInviteAllowlist: ["~TL07_inviter"],
        channelRules: { TL07_channel: { mode: "restricted", allowedShips: ["~TL07_rule_ship"] } },
      },
    ],
    counts: [0],
    hidden: ["~TL07_owner", "~TL07_authorized", "~TL07_inviter", "~TL07_rule_ship", "TL07_channel"],
    check: ([state]) => {
      expect(state.ownerShip).toBe("~TL07_owner");
      expect(state.defaultAuthorizedShips).toEqual(["~TL07_authorized"]);
      expect(state.groupInviteAllowlist).toEqual(["~TL07_inviter"]);
      expect(state.channelRules?.TL07_channel?.allowedShips).toEqual(["~TL07_rule_ship"]);
    },
  },
  {
    id: "CP60-TL08",
    name: "empty settings retain loaded/default semantics",
    loads: [{}],
    counts: [0],
    hidden: [],
    check: ([state]) => {
      expect(state.pendingApprovals).toBeUndefined();
      expect(state.dmAllowlist).toBeUndefined();
    },
  },
  {
    id: "CP60-TL09",
    name: "ordinary boolean flags survive load",
    loads: [
      {
        showModelSig: true,
        autoDiscoverChannels: false,
        autoAcceptDmInvites: true,
        autoAcceptGroupInvites: false,
      },
    ],
    counts: [0],
    hidden: [],
    check: ([state]) =>
      expect(state).toMatchObject({
        showModelSig: true,
        autoDiscoverChannels: false,
        autoAcceptDmInvites: true,
        autoAcceptGroupInvites: false,
      }),
  },
  {
    id: "CP60-TL10",
    name: "malformed approval ignored and repeated load sanitized",
    loads: [
      {
        pendingApprovals: [
          { id: "invalid", type: "dm", requestingShip: "TL10_invalid_without_timestamp" },
        ],
      },
      {
        pendingApprovals: [
          approval("valid", { originalMessage: originalMessage("TL10_second_load_text") }),
        ],
      },
    ],
    counts: [0, 1],
    hidden: ["TL10_invalid_without_timestamp", "TL10_second_load_text"],
    check: ([first, second]) => {
      expect(first.pendingApprovals).toEqual([]);
      expect(second?.pendingApprovals?.[0]?.originalMessage?.messageText).toBe(
        "TL10_second_load_text",
      );
    },
  },
];

describe("checkpoint-60 Tlon settings load logging", () => {
  it.each(cases)("$id $name", async ({ loads, counts, hidden, check }) => {
    const logs: string[] = [];
    let index = 0;
    const api = {
      async scry(path: string) {
        expect(path).toBe("/settings/all.json");
        const settings = loads[index];
        index += 1;
        return { all: { moltbot: { tlon: settings } } };
      },
    } as unknown as UrbitSSEClient;
    const manager = createSettingsManager(api, { log: (message) => logs.push(message) });
    const states: TlonSettingsStore[] = [];
    for (const count of counts) {
      states.push(structuredClone(await manager.load()));
      expect(manager.loaded).toBe(true);
      const output = logs.at(-1) ?? "";
      expect(output).toContain("[settings] Loaded:");
      expect(output).toMatch(/pendingApprovals|pending approvals/i);
      expect(output).toContain(String(count));
    }
    expect(logs).toHaveLength(counts.length);
    check(states as [TlonSettingsStore, ...TlonSettingsStore[]]);
    const output = logs.join("\n");
    for (const marker of hidden) {
      expect(output).not.toContain(marker);
    }
  });
});
