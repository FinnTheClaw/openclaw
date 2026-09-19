import { describe, expect, it } from "vitest";
import {
  parseJsonObjectPreservingUnsafeIntegers,
  parseJsonPreservingUnsafeIntegers,
  quoteUnsafeIntegerLiterals,
  safeParseJsonRecord,
} from "./json-coercion.js";

describe("exact integer JSON parsing", () => {
  it("preserves nested positive and negative identifiers without changing safe numbers", () => {
    expect(
      parseJsonPreservingUnsafeIntegers(
        '{"a":9223372036854775807,"b":[-9223372036854775807,9007199254740991,42]}',
      ),
    ).toEqual({
      a: "9223372036854775807",
      b: ["-9223372036854775807", 9007199254740991, 42],
    });
  });
  it("keeps decimals, exponents, and string contents unchanged", () => {
    const input = '{"decimal":1.25,"exp":1e3,"text":"id:9223372036854775807"}';
    expect(quoteUnsafeIntegerLiterals(input)).toBe(input);
    expect(parseJsonPreservingUnsafeIntegers(input)).toEqual(JSON.parse(input));
  });
  it.each(["", "[]", "null", '{"target":}', '{"target":9223372036854775807'])(
    "rejects malformed or non-object tool arguments %#",
    (value) => expect(parseJsonObjectPreservingUnsafeIntegers(value)).toBeNull(),
  );
  it("does not change existing generic safeParseJsonRecord numeric behavior", () => {
    expect(safeParseJsonRecord('{"target":9223372036854775807}')).toEqual({
      target: 9223372036854776000,
    });
  });
});
