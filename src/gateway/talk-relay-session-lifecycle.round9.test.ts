import { describe, expect, it, vi } from "vitest";
import { requireActiveTalkRelaySession } from "./talk-relay-session-lifecycle.js";

describe("GATEWAY-RELAY-R9-L01 connection ownership", () => {
  it.each([
    [
      "GATEWAY-RELAY-R9-L01-01 owner receives live session",
      "owner",
      "owner",
      60000,
      true,
      false,
      0,
    ],
    [
      "GATEWAY-RELAY-R9-L01-02 foreign connection is denied",
      "owner",
      "other",
      60000,
      true,
      true,
      0,
    ],
    [
      "GATEWAY-RELAY-R9-L01-03 foreign lookup does not close provider",
      "owner",
      "other",
      60000,
      true,
      true,
      0,
    ],
    [
      "GATEWAY-RELAY-R9-L01-04 foreign lookup retains registry entry",
      "owner",
      "other",
      60000,
      true,
      true,
      0,
    ],
    [
      "GATEWAY-RELAY-R9-L01-05 owner remains usable after foreign attempt",
      "owner",
      "other",
      60000,
      true,
      true,
      0,
    ],
    [
      "GATEWAY-RELAY-R9-L01-06 foreign expired session is not closed by foreign caller",
      "owner",
      "other",
      -1,
      true,
      true,
      0,
    ],
    ["GATEWAY-RELAY-R9-L01-07 missing session is denied", "owner", "owner", 60000, false, true, 0],
    [
      "GATEWAY-RELAY-R9-L01-08 owner expired session is closed",
      "owner",
      "owner",
      -1,
      true,
      true,
      1,
    ],
    [
      "GATEWAY-RELAY-R9-L01-09 owner invalid expiry is closed",
      "owner",
      "owner",
      -60000,
      true,
      true,
      1,
    ],
    [
      "GATEWAY-RELAY-R9-L01-10 another owner cannot close this session",
      "owner",
      "third",
      60000,
      true,
      true,
      0,
    ],
  ] as const)("%s", (_name, owner, requester, expiryDelta, present, throws, expectedCloses) => {
    const session = { connId: owner, expiresAtMs: Date.now() + expiryDelta };
    const sessions = new Map(present ? [["relay", session]] : []);
    const closeSession = vi.fn(() => {
      sessions.delete("relay");
    });
    const lookup = () =>
      requireActiveTalkRelaySession({
        sessions,
        sessionId: "relay",
        connId: requester,
        closeSession,
        unknownSessionMessage: "unknown relay",
      });
    if (throws) {
      expect(lookup).toThrow("unknown relay");
    } else {
      expect(lookup()).toBe(session);
    }
    expect(closeSession).toHaveBeenCalledTimes(expectedCloses);
    expect(sessions.has("relay")).toBe(present && expectedCloses === 0);
    if (present && requester !== owner && expiryDelta > 0) {
      expect(
        requireActiveTalkRelaySession({
          sessions,
          sessionId: "relay",
          connId: owner,
          closeSession,
          unknownSessionMessage: "unknown relay",
        }),
      ).toBe(session);
    }
  });
});
