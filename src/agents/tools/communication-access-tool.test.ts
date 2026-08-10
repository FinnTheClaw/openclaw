import { describe, expect, it } from "vitest";
import { createCommunicationAccessTool } from "./communication-access-tool.js";

describe("communication_access tool", () => {
  it("returns only the injected sanitized inventory", async () => {
    const tool = createCommunicationAccessTool({
      loadInventory: async () => ({
        entries: [
          {
            endpointType: "signal",
            boundState: "bound",
            routingState: "admin",
            authState: "authorized",
            redactedIdentifier: "***9113",
            label: "Administrator",
            linkedAt: "2026-08-09T10:00:00.000Z",
            evidenceRefs: ["communication-endpoint:fake-opaque-ref"],
          },
        ],
      }),
    });

    const result = await tool.execute("fake-call", {});
    const serialized = JSON.stringify(result);
    expect(result.details).toEqual({
      entries: [
        expect.objectContaining({
          endpointType: "signal",
          redactedIdentifier: "***9113",
          authState: "authorized",
        }),
      ],
    });
    expect(serialized).not.toContain("fake-hmac-secret-canary-never-expose");
    expect(serialized).not.toContain("+15125559113");
  });

  it("fails without reflecting protected-state errors", async () => {
    const tool = createCommunicationAccessTool({
      loadInventory: async () => {
        throw new Error("fake-hmac-secret-canary-never-expose at /fake/registry");
      },
    });

    await expect(tool.execute("fake-call", {})).rejects.toThrow(
      "Communication access inventory is unavailable.",
    );
  });
});
