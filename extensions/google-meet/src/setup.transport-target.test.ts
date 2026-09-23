import { describe, expect, it } from "vitest";
import { resolveGoogleMeetConfig, type GoogleMeetTransport } from "./config.js";
import { getGoogleMeetSetupStatus } from "./setup.js";

describe("Google Meet effective transport target check", () => {
  const cases: Array<{
    defaultTransport: GoogleMeetTransport;
    override?: GoogleMeetTransport;
    node?: string;
    expected: boolean;
  }> = [
    { defaultTransport: "chrome", override: "chrome-node", expected: false },
    { defaultTransport: "twilio", override: "chrome-node", expected: false },
    { defaultTransport: "chrome-node", expected: false },
    { defaultTransport: "chrome-node", override: "chrome", expected: true },
    { defaultTransport: "chrome-node", override: "twilio", expected: true },
    { defaultTransport: "chrome", expected: true },
    { defaultTransport: "twilio", expected: true },
    { defaultTransport: "chrome-node", node: "node-a", expected: true },
    { defaultTransport: "chrome", override: "chrome-node", node: "node-a", expected: true },
    { defaultTransport: "twilio", override: "chrome-node", node: "node-a", expected: true },
  ];

  it.each(cases)(
    "uses effective transport for %#",
    ({ defaultTransport, override, node, expected }) => {
      const config = resolveGoogleMeetConfig({
        defaultTransport,
        chromeNode: node ? { node } : undefined,
      });
      const status = getGoogleMeetSetupStatus(config, { transport: override, env: {} });
      const check = status.checks.find((entry) => entry.id === "chrome-node-target");
      expect(check?.ok).toBe(expected);
      if (!expected) {
        expect(check?.message).toContain("chromeNode.node");
      }
    },
  );
});
