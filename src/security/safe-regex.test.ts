// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

function expectCompiledRegex(pattern: string, flags?: string): RegExp {
  const re = compileSafeRegex(pattern, flags);
  expect(re).toBeInstanceOf(RegExp);
  if (!re) {
    throw new Error(`Expected ${pattern} to compile safely`);
  }
  return re;
}

describe("safe regex", () => {
  it.each([
    ["(a+)+$", null],
    ["(a|aa)+$", null],
    ["(a|aa){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
  });

  it("compiles common safe filter regex", () => {
    const re = expectCompiledRegex("^agent:.*:discord:");
    expect(re.test("agent:main:discord:channel:123")).toBe(true);
    expect(re.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = expectCompiledRegex("token=([A-Za-z0-9]+)", "gi");
    expect("TOKEN=abcd1234".replace(re, "***")).toBe("***");
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });

  describe("round-eight overlapping alternatives", () => {
    it("REGEX-01 rejects duplicate one-character branches under plus", () => {
      expect(compileSafeRegexDetailed("(a|a)+$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-02 rejects duplicate branches under star", () => {
      expect(compileSafeRegexDetailed("(ab|ab)*$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-03 rejects overlapping equal-length character classes", () => {
      expect(compileSafeRegexDetailed("([ab]|[bc])+$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-04 rejects equal-length alternatives with a shared literal prefix", () => {
      expect(compileSafeRegexDetailed("(ab|ac)+$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-05 continues rejecting unequal-length overlapping alternatives", () => {
      expect(compileSafeRegexDetailed("(a|aa)+$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-06 continues rejecting nested repetition", () => {
      expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
    });

    it("REGEX-07 accepts disjoint equal-length literal alternatives", () => {
      const re = expectCompiledRegex("^(a|b)+$");
      expect(re.test("abba")).toBe(true);
      expect(re.test("abbc")).toBe(false);
    });

    it("REGEX-08 preserves fixed-repeat ambiguous alternatives", () => {
      const re = expectCompiledRegex("^(a|a){2}$");
      expect(re.test("aa")).toBe(true);
    });

    it("REGEX-09 preserves a common safe agent filter", () => {
      const re = expectCompiledRegex("^agent:.*:discord:");
      expect(re.test("agent:main:discord:channel:123")).toBe(true);
      expect(re.test("agent:main:telegram:channel:123")).toBe(false);
    });

    it("REGEX-10 runs admitted patterns on only short bounded nonmatches", () => {
      const re = expectCompiledRegex("^(a|b)+$");
      expect(testRegexWithBoundedInput(re, "a".repeat(12) + "!", 16)).toBe(false);
      expect(testRegexWithBoundedInput(re, "a".repeat(12) + "!", 0)).toBe(false);
    });
  });
});
