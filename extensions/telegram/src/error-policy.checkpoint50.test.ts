import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldSuppressTelegramError } from "./error-policy.js";

let scopeNumber = 0;
const nextScope = () => `checkpoint50-telegram-once-${scopeNumber++}`;
const check = (scopeKey: string, errorMessage: string, cooldownMs = 1000) =>
  shouldSuppressTelegramError({ scopeKey, errorMessage, cooldownMs });

describe("TELEGRAM-ONCE-R4-01 ten-case production-component pack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("TELEGRAM-ONCE-R4-01-C01 first distinct error is allowed", () => {
    expect(check(nextScope(), "first")).toBe(false);
  });
  it("TELEGRAM-ONCE-R4-01-C02 same error within cooldown is suppressed", () => {
    const scope = nextScope();
    expect(check(scope, "same")).toBe(false);
    expect(check(scope, "same")).toBe(true);
  });
  it("TELEGRAM-ONCE-R4-01-C03 same error after expiry is allowed", () => {
    const scope = nextScope();
    expect(check(scope, "same")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(check(scope, "same")).toBe(false);
  });
  it("TELEGRAM-ONCE-R4-01-C04 129 distinct errors remain admissible", () => {
    const scope = nextScope();
    for (let i = 0; i < 129; i++) {
      expect(check(scope, `error-${i}`)).toBe(false);
    }
  });
  it("TELEGRAM-ONCE-R4-01-C05 newest distinct error remains suppressed", () => {
    const scope = nextScope();
    for (let i = 0; i < 129; i++) {
      check(scope, `error-${i}`);
    }
    expect(check(scope, "error-128")).toBe(true);
  });
  it("TELEGRAM-ONCE-R4-01-C06 oldest entry is evicted deterministically", () => {
    const scope = nextScope();
    for (let i = 0; i < 129; i++) {
      check(scope, `error-${i}`);
    }
    expect(check(scope, "error-0")).toBe(false);
    expect(check(scope, "error-1")).toBe(false);
  });
  it("TELEGRAM-ONCE-R4-01-C07 same message in another scope remains independent", () => {
    const first = nextScope();
    const second = nextScope();
    expect(check(first, "same")).toBe(false);
    expect(check(second, "same")).toBe(false);
    expect(check(first, "same")).toBe(true);
    expect(check(second, "same")).toBe(true);
  });
  it("TELEGRAM-ONCE-R4-01-C08 expired entries are pruned before cap eviction", () => {
    const scope = nextScope();
    expect(check(scope, "old", 1)).toBe(false);
    vi.advanceTimersByTime(2);
    for (let i = 0; i < 128; i++) {
      check(scope, `fresh-${i}`);
    }
    expect(check(scope, "fresh-0")).toBe(true);
    expect(check(scope, "old")).toBe(false);
  });
  it("TELEGRAM-ONCE-R4-01-C09 long error text still follows once semantics", () => {
    const scope = nextScope();
    const message = "x".repeat(10000);
    expect(check(scope, message)).toBe(false);
    expect(check(scope, message)).toBe(true);
  });
  it("TELEGRAM-ONCE-R4-01-C10 caller-style String(Error) values are bounded", () => {
    const scope = nextScope();
    for (let i = 0; i < 129; i++) {
      expect(check(scope, String(new Error(`variable-${i}`)))).toBe(false);
    }
    expect(check(scope, String(new Error("variable-128")))).toBe(true);
    expect(check(scope, String(new Error("variable-0")))).toBe(false);
  });
});
