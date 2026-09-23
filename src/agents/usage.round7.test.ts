import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./embedded-agent-runner/usage-accumulator.js";
import { hasNonzeroUsage, hasObservedModelUsage, normalizeUsage } from "./usage.js";

describe("round-seven one-hour cache-write accounting", () => {
  it("U01 retains positive one-hour writes alone", () => {
    const usage = normalizeUsage({ cacheWrite1h: 40 });
    expect(usage).toMatchObject({ cacheWrite1h: 40 });
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("U02 retains observed zero without claiming positive usage", () => {
    const usage = normalizeUsage({ cacheWrite1h: 0 });
    expect(usage).toMatchObject({ cacheWrite1h: 0 });
    expect(hasNonzeroUsage(usage)).toBe(false);
  });

  it("U03 clamps negative one-hour writes to zero", () => {
    const usage = normalizeUsage({ cacheWrite1h: -1 });
    expect(usage).toMatchObject({ cacheWrite1h: 0 });
    expect(hasNonzeroUsage(usage)).toBe(false);
  });

  it("U04 ignores NaN-only one-hour write payloads", () => {
    expect(normalizeUsage({ cacheWrite1h: Number.NaN })).toBeUndefined();
  });

  it("U05 ignores infinite-only one-hour write payloads", () => {
    expect(normalizeUsage({ cacheWrite1h: Infinity })).toBeUndefined();
  });

  it("U06 truncates fractional one-hour writes", () => {
    const usage = normalizeUsage({ cacheWrite1h: 40.9 });
    expect(usage).toMatchObject({ cacheWrite1h: 40 });
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("U07 caps oversized one-hour writes safely", () => {
    const usage = normalizeUsage({ cacheWrite1h: Number.MAX_SAFE_INTEGER + 1000 });
    expect(usage).toMatchObject({ cacheWrite1h: Number.MAX_SAFE_INTEGER });
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("U08 retains one-hour and aggregate cache writes separately", () => {
    const usage = normalizeUsage({ cacheWrite1h: 40, cacheWrite: 20 });
    expect(usage).toMatchObject({ cacheWrite1h: 40, cacheWrite: 20 });
  });

  it("U09 retains billed zero cost with one-hour writes", () => {
    const usage = normalizeUsage({
      cacheWrite1h: 40,
      cost: { total: 0, totalOrigin: "provider-billed" },
    });
    expect(usage).toMatchObject({ cacheWrite1h: 40, cost: { total: 0 } });
    expect(hasObservedModelUsage(usage)).toBe(true);
  });

  it("U10 passes one-hour-only usage through the real accumulator", () => {
    const acc = createUsageAccumulator();
    mergeUsageIntoAccumulator(acc, normalizeUsage({ cacheWrite1h: 40 }));
    const usage = toNormalizedUsage(acc);
    expect(usage).toMatchObject({ cacheWrite1h: 40 });
    expect(usage?.input).toBeUndefined();
    expect(usage?.output).toBeUndefined();
  });
});
