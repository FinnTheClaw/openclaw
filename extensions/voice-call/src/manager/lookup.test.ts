// Voice Call tests cover lookup plugin behavior.
import { describe, expect, it } from "vitest";
import { findCall, getCallByProviderCallId } from "./lookup.js";

describe("voice-call manager lookup", () => {
  it("resolves provider call ids from the explicit map first", () => {
    const activeCalls = new Map([
      ["call-1", { id: "call-1", providerCallId: "prov-1" }],
      ["call-2", { id: "call-2", providerCallId: "prov-2" }],
    ]);
    const providerCallIdMap = new Map([["provider-lookup", "call-2"]]);

    expect(
      getCallByProviderCallId({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        providerCallId: "provider-lookup",
      }),
    ).toEqual({ id: "call-2", providerCallId: "prov-2" });
  });

  it("falls back to scanning active calls and supports direct call ids", () => {
    const activeCalls = new Map([
      ["call-1", { id: "call-1", providerCallId: "prov-1" }],
      ["call-2", { id: "call-2", providerCallId: "prov-2" }],
    ]);
    const providerCallIdMap = new Map<string, string>();

    expect(
      getCallByProviderCallId({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        providerCallId: "prov-1",
      }),
    ).toEqual({ id: "call-1", providerCallId: "prov-1" });

    expect(
      findCall({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        callIdOrProviderCallId: "call-2",
      }),
    ).toEqual({ id: "call-2", providerCallId: "prov-2" });

    expect(
      findCall({
        activeCalls: activeCalls as never,
        providerCallIdMap,
        callIdOrProviderCallId: "missing",
      }),
    ).toBeUndefined();
  });
  it.each([
    {
      name: "L4-01 stale map scans the first provider id",
      mapping: [["prov-1", "gone"]],
      query: "prov-1",
      expected: "call-1",
    },
    {
      name: "L4-01 stale map scans the second provider id",
      mapping: [["prov-2", "gone"]],
      query: "prov-2",
      expected: "call-2",
    },
    {
      name: "L4-01 stale alias mapping scans a matching active provider id",
      mapping: [["alias-1", "gone"]],
      query: "alias-1",
      expected: "call-3",
    },
    {
      name: "L4-01 stale map returns undefined without a matching active call",
      mapping: [["absent", "gone"]],
      query: "absent",
      expected: undefined,
    },
    {
      name: "L4-01 live alias mapping remains authoritative",
      mapping: [["alias-1", "call-2"]],
      query: "alias-1",
      expected: "call-2",
    },
    {
      name: "L4-01 findCall scans after a stale provider mapping",
      mapping: [["prov-1", "gone"]],
      query: "prov-1",
      viaFind: true,
      expected: "call-1",
    },
    {
      name: "L4-01 findCall keeps direct internal ids ahead of mappings",
      mapping: [["call-1", "call-2"]],
      query: "call-1",
      viaFind: true,
      expected: "call-1",
    },
    {
      name: "L4-01 stale mapping scan skips a nonmatching active call",
      mapping: [["prov-2", "gone"]],
      query: "prov-2",
      expected: "call-2",
    },
    {
      name: "L4-01 stale mapping scan supports an empty provider id",
      mapping: [["", "gone"]],
      query: "",
      expected: "call-4",
    },
    {
      name: "L4-01 findCall reports an unmatched stale alias as absent",
      mapping: [["missing-alias", "gone"]],
      query: "missing-alias",
      viaFind: true,
      expected: undefined,
    },
  ] as Array<{
    name: string;
    mapping: [string, string][];
    query: string;
    expected?: string;
    viaFind?: boolean;
  }>)("$name", ({ mapping, query, expected, viaFind }) => {
    const activeCalls = new Map([
      ["call-1", { id: "call-1", providerCallId: "prov-1" }],
      ["call-2", { id: "call-2", providerCallId: "prov-2" }],
      ["call-3", { id: "call-3", providerCallId: "alias-1" }],
      ["call-4", { id: "call-4", providerCallId: "" }],
    ]);
    const providerCallIdMap = new Map(mapping);
    const result = viaFind
      ? findCall({
          activeCalls: activeCalls as never,
          providerCallIdMap,
          callIdOrProviderCallId: query,
        })
      : getCallByProviderCallId({
          activeCalls: activeCalls as never,
          providerCallIdMap,
          providerCallId: query,
        });
    expect(result?.id).toBe(expected);
  });
});
