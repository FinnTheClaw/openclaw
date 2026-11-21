import { describe, expect, it } from "vitest";
import { createToolCallLookup } from "./chat-thread-run-identity.ts";

describe("partially visible tool call ownership", () => {
  it("does not borrow a unique tool fact from a conflicting known run", () => {
    const lookup = createToolCallLookup<string>();
    lookup.add("run-a", "shared-call", "A");
    expect(lookup.get("run-b", "shared-call")).toBeUndefined();
    expect(lookup.get("run-a", "shared-call")).toBe("A");
    expect(lookup.get(undefined, "shared-call")).toBe("A");
  });
  it("retains legacy unscoped facts only while unambiguous", () => {
    const lookup = createToolCallLookup<string>();
    lookup.add(undefined, "shared-call", "legacy");
    expect(lookup.get("run-b", "shared-call")).toBe("legacy");
    lookup.add("run-a", "shared-call", "A");
    expect(lookup.get("run-b", "shared-call")).toBeUndefined();
    expect(lookup.get(undefined, "shared-call")).toBeUndefined();
    expect(lookup.get("run-a", "shared-call")).toBe("A");
  });
});
