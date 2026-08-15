import { describe, expect, it } from "vitest";
import { FunctionalFinnTransientStore } from "./transient-store.js";

describe("Functional Finn transient evidence store", () => {
  it("expires raw content without persistence", () => {
    let now = 100;
    const store = new FunctionalFinnTransientStore<string>(2, () => now);
    expect(store.registerIfAbsent("one", "private message", { ttlMs: 10 })).toBe(true);
    expect(store.lookup("one")).toBe("private message");
    now = 110;
    expect(store.lookup("one")).toBeUndefined();
    expect(store.entries()).toEqual([]);
  });

  it("evicts the oldest entry at its hard bound", () => {
    const store = new FunctionalFinnTransientStore<string>(2);
    store.registerIfAbsent("one", "1");
    store.registerIfAbsent("two", "2");
    store.registerIfAbsent("three", "3");
    expect(store.lookup("one")).toBeUndefined();
    expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
  });
});
