import { describe, expect, it } from "vitest";
import { resolveMatrixMonitorAccessState } from "./access-state.js";

type Params = Parameters<typeof resolveMatrixMonitorAccessState>[0];
const base: Params = {
  allowFrom: [],
  storeAllowFrom: [],
  groupAllowFrom: [],
  roomUsers: [],
  senderId: "@alice:example.org",
  isRoom: true,
};

describe("CH07 Matrix explicit empty allowlist", () => {
  it.each([
    { id: "P01 empty denies message", params: { groupPolicy: "allowlist" }, decision: "block" },
    {
      id: "P02 empty denies reaction",
      params: { groupPolicy: "allowlist", eventKind: "reaction" },
      decision: "block",
    },
    {
      id: "P03 allowlist match",
      params: { groupPolicy: "allowlist", groupAllowFrom: ["@alice:example.org"] },
      decision: "allow",
    },
    {
      id: "P04 allowlist mismatch",
      params: { groupPolicy: "allowlist", groupAllowFrom: ["@bob:example.org"] },
      decision: "block",
    },
    {
      id: "P05 room override match",
      params: { groupPolicy: "open", roomUsers: ["@alice:example.org"] },
      decision: "allow",
    },
    {
      id: "P06 room override mismatch",
      params: { groupPolicy: "open", roomUsers: ["@bob:example.org"] },
      decision: "block",
    },
    { id: "P07 open remains open", params: { groupPolicy: "open" }, decision: "allow" },
    {
      id: "P08 disabled remains closed",
      params: { groupPolicy: "disabled", groupAllowFrom: ["@alice:example.org"] },
      decision: "block",
    },
    {
      id: "P09 numeric entry no bypass",
      params: { groupPolicy: "allowlist", groupAllowFrom: [123] },
      decision: "block",
    },
    {
      id: "P10 DM stays on DM allowlist",
      params: {
        isRoom: false,
        dmPolicy: "allowlist",
        allowFrom: ["@alice:example.org"],
        groupPolicy: "allowlist",
      },
      decision: "allow",
    },
  ] as Array<{ id: string; params: Partial<Params>; decision: "allow" | "block" }>)(
    "$id",
    async ({ params, decision }) => {
      const state = await resolveMatrixMonitorAccessState({ ...base, ...params });
      expect(state.messageIngress.ingress.decision).toBe(decision);
    },
  );
});
