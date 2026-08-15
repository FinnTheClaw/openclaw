import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionalFinnIngressPull } from "./functional-finn-ingress-client.js";

const fixture = JSON.parse(
  readFileSync("test/fixtures/functional-finn-release-ipc.json", "utf8"),
) as { ingressPullCanonical: string };

describe("Functional Finn ingress canonical client", () => {
  it("matches the Python ingress fixture byte-for-byte", () => {
    const packet = encodeFunctionalFinnIngressPull({
      requestId: "pull-1",
      afterOrdinal: 7,
      limit: 20,
    });
    expect(packet.readUInt32BE(0)).toBe(packet.length - 4);
    expect(packet.subarray(4).toString("utf8")).toBe(fixture.ingressPullCanonical);
  });

  it("rejects unsafe cursor numbers before connecting", () => {
    expect(() =>
      encodeFunctionalFinnIngressPull({ requestId: "pull-1", afterOrdinal: 1.5, limit: 20 }),
    ).toThrow(/integer/);
  });
});
