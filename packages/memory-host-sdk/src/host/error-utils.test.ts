import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "./error-utils.js";

describe("formatErrorMessage", () => {
  it.each([
    ["bearer memory/Start~opaque-memoryEnd", "bearer memory...yEnd"],
    ['{"Authorization":"bearer t7K4_x"}', '{"Authorization":"bearer ***"}'],
  ])("redacts bearer credentials from %s", (input, expected) => {
    expect(formatErrorMessage(input)).toBe(expected);
  });
});
