import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "../client.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";

const sender = "+15555550123";
const historyRow = (id: number, guid: string, text: string, minute: string, fromMe = false) => ({
  id,
  guid,
  text,
  chat_id: 44,
  sender: fromMe ? null : sender,
  is_from_me: fromMe,
  is_group: false,
  created_at: `2026-05-25T12:${minute}:00.000Z`,
});

describe("resolveIMessageDmHistoryLimit", () => {
  it("uses per-DM history overrides before the provider default", () => {
    expect(
      resolveIMessageDmHistoryLimit({
        config: {
          dmHistoryLimit: 5,
          dms: { [sender]: { historyLimit: 2 } },
        },
        sender: "+1 (555) 555-0123",
        senderNormalized: sender,
      }),
    ).toBe(2);
  });

  it("defaults to disabled when no iMessage DM history limit is configured", () => {
    expect(resolveIMessageDmHistoryLimit({ config: {}, sender })).toBe(0);
  });
});

describe("resolveIMessageDmHistoryContext", () => {
  it("fetches decoded imsg history rows and excludes the current message", async () => {
    const request = vi.fn(async () => ({
      messages: [
        historyRow(8, "previous-in", "earlier inbound", "00"),
        historyRow(9, "previous-out", "earlier outbound", "01", true),
        historyRow(10, "current", "current", "02"),
      ],
    }));

    const context = await resolveIMessageDmHistoryContext({
      client: { request } as unknown as IMessageRpcClient,
      message: { ...historyRow(10, "current", "current", "02"), sender },
      senderNormalized: sender,
      limit: 2,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });

    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 44, limit: 3, attachments: false },
      { timeoutMs: 10_000 },
    );
    expect(context.inboundHistory).toEqual([
      {
        sender,
        body: "earlier inbound",
        timestamp: Date.parse("2026-05-25T12:00:00.000Z"),
      },
      {
        sender: "Me",
        body: "earlier outbound",
        timestamp: Date.parse("2026-05-25T12:01:00.000Z"),
      },
    ]);
    expect(context.body).toContain("earlier inbound");
    expect(context.body).toContain("earlier outbound");
    expect(context.body).not.toContain("current");
  });
});

describe("iMessage DM history temporal ordering", () => {
  const earlier = "2026-05-25T12:00:00.000Z";
  const currentTime = "2026-05-25T12:02:00.000Z";
  const later = "2026-05-25T12:04:00.000Z";
  const cases: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>, string[]]> =
    [
      ["IM1 numeric IDs earlier accepted", { id: 10 }, [{ id: 9, text: "earlier" }], ["earlier"]],
      ["IM2 numeric IDs later excluded", { id: 10 }, [{ id: 11, text: "later" }], []],
      ["IM3 same GUID excluded without IDs", {}, [{ guid: "current", text: "same" }], []],
      [
        "IM4 different GUID newer timestamp excluded",
        {},
        [{ created_at: later, text: "newer" }],
        [],
      ],
      [
        "IM5 different GUID older timestamp accepted",
        {},
        [{ created_at: earlier, text: "older" }],
        ["older"],
      ],
      ["IM6 equal timestamps excluded as ambiguous", {}, [{ text: "equal" }], []],
      [
        "IM7 missing current timestamp excludes GUID-only row",
        { created_at: undefined },
        [{ created_at: earlier, text: "unknown" }],
        [],
      ],
      [
        "IM8 invalid row timestamp excludes row",
        {},
        [{ created_at: "invalid", text: "invalid" }],
        [],
      ],
      [
        "IM9 mixed numeric and missing ID uses timestamps",
        { id: 10 },
        [{ created_at: earlier, text: "mixed" }],
        ["mixed"],
      ],
    ];

  it.each(cases)("%s", async (_name, currentOverrides, rowOverrides, expectedBodies) => {
    const current = {
      chat_id: 44,
      guid: "current",
      created_at: currentTime,
      text: "current",
      is_group: false,
      ...currentOverrides,
    };
    const request = vi.fn(async () => ({
      messages: rowOverrides.map((row, index) => ({
        chat_id: 44,
        guid: `row-${index}`,
        created_at: currentTime,
        text: `row-${index}`,
        is_group: false,
        ...row,
      })),
    }));
    const context = await resolveIMessageDmHistoryContext({
      client: { request } as unknown as IMessageRpcClient,
      message: current,
      senderNormalized: "+15555550123",
      limit: 10,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });
    expect(context.inboundHistory?.map((entry) => entry.body) ?? []).toEqual(expectedBodies);
  });

  it("IM10 unsorted history keeps only earlier rows in time order within limit", async () => {
    const request = vi.fn(async () => ({
      messages: [
        { chat_id: 44, guid: "late", created_at: later, text: "late" },
        { chat_id: 44, guid: "b", created_at: "2026-05-25T12:01:00.000Z", text: "b" },
        { chat_id: 44, guid: "a", created_at: earlier, text: "a" },
        { chat_id: 44, guid: "current", created_at: currentTime, text: "current" },
      ],
    }));
    const context = await resolveIMessageDmHistoryContext({
      client: { request } as unknown as IMessageRpcClient,
      message: { chat_id: 44, guid: "current", created_at: currentTime, text: "current" },
      senderNormalized: "+15555550123",
      limit: 2,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });
    expect(context.inboundHistory?.map((entry) => entry.body)).toEqual(["a", "b"]);
  });
});
