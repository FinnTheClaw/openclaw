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

type CanonicalTextFixture = {
  accepted: Array<{
    value: string;
    quote: string;
    startUtf16: number;
    endUtf16: number;
    startByte: number;
    endByte: number;
  }>;
  rejected: Array<{ name: string; value: string }>;
};

const fixture = JSON.parse(
  readFileSync("test/fixtures/functional-finn-release-ipc.json", "utf8"),
) as Fixture;
const canonicalText = JSON.parse(
  readFileSync("test/fixtures/functional-finn-canonical-text.json", "utf8"),
) as CanonicalTextFixture;

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

  it.each(canonicalText.rejected)(
    "rejects shared non-canonical IPC text $name before opening a socket",
    ({ value: message }) => {
      expect(() =>
        encodeFunctionalFinnCandidateValidation({
          requestId: "request-1",
          candidate: { ...fixture.candidate, message },
        }),
      ).toThrow(/canonical/);
    },
  );

  it.each(canonicalText.accepted)(
    "preserves canonical $value with shared UTF-8 byte spans",
    ({ value, quote, startByte, endByte }) => {
      const candidate: ExternalCandidate = {
        ...fixture.candidate,
        message: value,
        claims: [
          {
            claimId: "claim-unicode",
            text: value,
            evidence: [
              {
                kind: "signal_ingress",
                ingressId: "ingress-001",
                startByte,
                endByte,
                quote,
                receiptId: null,
              },
            ],
          },
        ],
      };
      const encoded = body(
        encodeFunctionalFinnCandidateValidation({ requestId: "unicode-1", candidate }),
      );
      expect(encoded).toContain(`"startByte":${startByte}`);
      expect(encoded).toContain(`"endByte":${endByte}`);
    },
  );
});
