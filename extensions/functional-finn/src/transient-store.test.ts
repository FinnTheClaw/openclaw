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

  it("evicts raw evidence to stay within a hard byte budget", () => {
    const store = new FunctionalFinnTransientStore<string>(10, Date.now, 8, (value) =>
      Buffer.byteLength(value),
    );
    expect(store.registerIfAbsent("one", "1234")).toBe(true);
    expect(store.registerIfAbsent("two", "5678")).toBe(true);
    expect(store.lookup("one")).toBeUndefined();
    expect(store.lookup("two")).toBe("5678");
    expect(store.registerIfAbsent("huge", "12345")).toBe(false);
    expect(store.lookup("two")).toBe("5678");
  });

  it("releases expired entry bytes before admitting new evidence", () => {
    let now = 0;
    const store = new FunctionalFinnTransientStore<string>(
      10,
      () => now,
      8,
      (value) => Buffer.byteLength(value),
    );
    store.registerIfAbsent("one", "1234", { ttlMs: 1 });
    now = 1;
    expect(store.registerIfAbsent("two", "5678")).toBe(true);
    expect(store.entries()).toEqual([{ key: "two", value: "5678" }]);
  });
});
