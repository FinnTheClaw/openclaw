import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFunctionalFinnSignalFrame,
  digestFunctionalFinnSignalFrame,
  encodeFunctionalFinnSignalFrame,
} from "./functional-finn-signal-frame.js";

type Fixture = {
  name: string;
  frame: Record<string, unknown>;
  encodedHex: string;
  digest: string;
};

type InvalidFixture = Pick<Fixture, "name" | "frame">;

const fixtures = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL("../../../test/fixtures/functional-finn-signal-frames.json", import.meta.url),
    ),
    "utf8",
  ),
) as Fixture[];

const invalidFixtures = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL("../../../test/fixtures/functional-finn-signal-frame-invalid.json", import.meta.url),
    ),
    "utf8",
  ),
) as InvalidFixture[];

describe("Functional Finn Signal transport frame", () => {
  it.each(fixtures)("encodes $name byte-for-byte", ({ frame, encodedHex, digest }) => {
    expect(encodeFunctionalFinnSignalFrame(frame).toString("hex")).toBe(encodedHex);
    expect(digestFunctionalFinnSignalFrame(frame)).toBe(digest);
  });

  it.each(invalidFixtures)("rejects $name", ({ frame }) => {
    expect(() => encodeFunctionalFinnSignalFrame(frame)).toThrow(/noncanonical/);
  });

  it("builds the closed RPC schema and distinguishes quoted fallback", () => {
    const plain = buildFunctionalFinnSignalFrame({
      accountId: "default",
      rpcParams: {
        message: "reply",
        account: "+15550001111",
        recipient: ["+15551234567"],
      },
    });
    const quoted = buildFunctionalFinnSignalFrame({
      accountId: "default",
      rpcParams: {
        message: "reply",
        account: "+15550001111",
        recipient: ["+15551234567"],
        quoteTimestamp: 123,
        quoteAuthor: "+15550002222",
        quoteMessage: "original",
      },
    });
    expect(digestFunctionalFinnSignalFrame(quoted)).not.toBe(
      digestFunctionalFinnSignalFrame(plain),
    );
  });

  it("rejects unknown, nested generic, non-finite, unsafe, and non-NFC values", () => {
    const base = fixtures[0]?.frame;
    const sparseStyles: string[] = [];
    sparseStyles.length = 1;
    expect(() => encodeFunctionalFinnSignalFrame({ ...base, extra: true })).toThrow(/unknown/);
    expect(() =>
      encodeFunctionalFinnSignalFrame({ schema: 1, method: "send", params: {} }),
    ).toThrow(/unknown|missing/);
    expect(() => encodeFunctionalFinnSignalFrame({ ...base, quoteTimestamp: Number.NaN })).toThrow(
      /quote/,
    );
    expect(() =>
      encodeFunctionalFinnSignalFrame({ ...base, quoteTimestamp: 9_007_199_254_740_992 }),
    ).toThrow(/quote/);
    expect(() => encodeFunctionalFinnSignalFrame({ ...base, message: "cafe\u0301" })).toThrow(
      /noncanonical/,
    );
    expect(() => encodeFunctionalFinnSignalFrame({ ...base, textStyle: sparseStyles })).toThrow(
      /noncanonical/,
    );
    expect(() =>
      buildFunctionalFinnSignalFrame({
        accountId: "default",
        rpcParams: { message: "x", recipient: ["+1"], attachments: ["/tmp/x"] },
      }),
    ).toThrow(/unsupported RPC fields/);
  });
});
