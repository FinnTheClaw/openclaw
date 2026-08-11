import { describe, expect, it } from "vitest";
import { assertGovernorJsonResources, GovernorResourceGuardError } from "./resource-guard.js";

const generous = {
  maxUtf8Bytes: 10_000,
  maxStringBytes: 10_000,
  maxDepth: 10,
  maxNodes: 100,
  maxProperties: 100,
  maxArrayLength: 100,
  maxCollections: 100,
};

function rejects(
  value: unknown,
  reason: GovernorResourceGuardError["reason"],
  overrides: Partial<typeof generous> = {},
): void {
  try {
    assertGovernorJsonResources(value, { ...generous, ...overrides });
    throw new Error("expected resource guard rejection");
  } catch (error) {
    expect(error, `expected resource guard rejection for ${reason}`).toBeInstanceOf(
      GovernorResourceGuardError,
    );
    expect((error as GovernorResourceGuardError).reason).toBe(reason);
  }
}

describe("governor JSON resource guard", () => {
  it("accepts exact UTF-8 boundary and rejects one byte over without echoing input", () => {
    assertGovernorJsonResources("éé", {
      ...generous,
      maxUtf8Bytes: 4,
      maxStringBytes: 4,
    });
    const marker = "UNTRUSTED_RESOURCE_MARKER";
    try {
      assertGovernorJsonResources(`${marker}é`, {
        ...generous,
        maxUtf8Bytes: 4,
        maxStringBytes: 4,
      });
      throw new Error("expected byte-bound rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernorResourceGuardError);
      expect(String(error)).not.toContain(marker);
    }
  });

  it("bounds depth, nodes, properties, arrays, collections, and string size", () => {
    rejects({ a: { b: { c: true } } }, "max_depth", { maxDepth: 2 });
    rejects({ a: true, b: true }, "max_nodes", { maxNodes: 2 });
    rejects({ a: true, b: true }, "max_properties", { maxProperties: 1 });
    rejects([true, false, null], "max_array_length", { maxArrayLength: 2 });
    rejects({ a: [] }, "max_collections", { maxCollections: 1 });
    rejects("x".repeat(11), "max_string_bytes", { maxStringBytes: 10 });
  });

  it("rejects cycles, accessors, unsupported prototypes, and detectable proxies", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    rejects(cycle, "cycle");

    let getterReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "must not be read";
      },
    });
    rejects(accessor, "accessor");
    expect(getterReads).toBe(0);

    rejects(new Date(0), "prototype");
    rejects(
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("trap");
          },
        },
      ),
      "proxy_or_unreadable",
    );
  });

  it("rejects non-finite numbers, invalid unicode, pollution keys, and unsupported values", () => {
    rejects(Number.NaN, "non_finite_number");
    rejects(String.fromCharCode(0xd800), "invalid_unicode");
    rejects(JSON.parse('{"__proto__":true}'), "prototype_pollution_key");
    rejects({ constructor: true }, "prototype_pollution_key");
    rejects(() => true, "unsupported_type");
    rejects(1n, "unsupported_type");
  });
});
