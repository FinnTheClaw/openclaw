import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  digestFunctionalFinnCandidate,
  encodeFunctionalFinnCandidateRelease,
  encodeFunctionalFinnCandidateValidation,
  type ExternalCandidate,
} from "./release-authority-client.js";

type Fixture = {
  candidate: ExternalCandidate;
  candidateDigest: string;
  validationCanonical: string;
  releaseCanonical: string;
};

const fixture = JSON.parse(
  readFileSync("test/fixtures/functional-finn-release-ipc.json", "utf8"),
) as Fixture;

function body(packet: Buffer): string {
  const length = packet.readUInt32BE(0);
  expect(length).toBe(packet.length - 4);
  return packet.subarray(4).toString("utf8");
}

describe("Functional Finn release authority canonical client", () => {
  it("matches the Python validation and release fixture byte-for-byte", () => {
    expect(digestFunctionalFinnCandidate(fixture.candidate)).toBe(fixture.candidateDigest);
    expect(
      body(
        encodeFunctionalFinnCandidateValidation({
          requestId: "request-1",
          candidate: fixture.candidate,
        }),
      ),
    ).toBe(fixture.validationCanonical);
    expect(
      body(
        encodeFunctionalFinnCandidateRelease({
          requestId: "release-1",
          candidate: fixture.candidate,
        }),
      ),
    ).toBe(fixture.releaseCanonical);
  });

  it("rejects non-canonical numeric values before opening a socket", () => {
    expect(() =>
      encodeFunctionalFinnCandidateValidation({
        requestId: "request-1",
        candidate: { ...fixture.candidate, revision: Number.NaN as 0 },
      }),
    ).toThrow(/integer/);
  });
});
