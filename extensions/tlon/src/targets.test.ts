// Two-part Tlon group shorthand must never route empty host or channel components.
import { describe, expect, it } from "vitest";
import { parseTlonTarget, resolveTlonOutboundTarget } from "./targets.js";

describe("Tlon group target shorthand", () => {
  it("T01 parses a valid group host and channel", () => {
    expect(parseTlonTarget("group:~host/channel")).toEqual({
      kind: "group",
      hostShip: "~host",
      channelName: "channel",
      nest: "chat/~host/channel",
    });
    expect(resolveTlonOutboundTarget("group:~host/channel")).toEqual({
      ok: true,
      to: "chat/~host/channel",
    });
  });

  it("T02 parses a valid room alias", () => {
    expect(parseTlonTarget("room:~host/channel")).toMatchObject({
      kind: "group",
      nest: "chat/~host/channel",
    });
  });

  it("T03 normalizes an unprefixed host ship", () => {
    expect(parseTlonTarget("group:host/channel")).toMatchObject({
      kind: "group",
      hostShip: "~host",
      nest: "chat/~host/channel",
    });
  });

  it("T04 retains the tlon-prefixed group form", () => {
    expect(parseTlonTarget("tlon:group:~host/channel")).toMatchObject({
      kind: "group",
      nest: "chat/~host/channel",
    });
  });

  it("T05 rejects an empty group host", () => {
    expect(parseTlonTarget("group:/channel")).toBeNull();
    expect(resolveTlonOutboundTarget("group:/channel")).toMatchObject({ ok: false });
  });

  it("T06 rejects an empty group channel", () => {
    expect(parseTlonTarget("group:~host/")).toBeNull();
    expect(resolveTlonOutboundTarget("group:~host/")).toMatchObject({ ok: false });
  });

  it("T07 rejects an empty room host", () => {
    expect(parseTlonTarget("room:/channel")).toBeNull();
    expect(resolveTlonOutboundTarget("room:/channel")).toMatchObject({ ok: false });
  });

  it("T08 rejects an empty room channel", () => {
    expect(parseTlonTarget("room:~host/")).toBeNull();
    expect(resolveTlonOutboundTarget("room:~host/")).toMatchObject({ ok: false });
  });

  it("T09 rejects whitespace-only host", () => {
    expect(parseTlonTarget("group:   /channel")).toBeNull();
    expect(resolveTlonOutboundTarget("group:   /channel")).toMatchObject({ ok: false });
  });

  it("T10 rejects whitespace-only channel", () => {
    expect(parseTlonTarget("group:~host/   ")).toBeNull();
    expect(resolveTlonOutboundTarget("group:~host/   ")).toMatchObject({ ok: false });
  });
});
