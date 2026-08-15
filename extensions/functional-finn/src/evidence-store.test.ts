import { describe, expect, it, vi } from "vitest";
import { serializeBoundedFunctionalFinnEvidence } from "./bounded-evidence.js";
import {
  FunctionalFinnEvidenceStore,
  type FunctionalFinnStoredEvidence,
} from "./evidence-store.js";

function memoryStore() {
  const values = new Map<string, FunctionalFinnStoredEvidence>();
  return {
    registerIfAbsent(key: string, value: FunctionalFinnStoredEvidence) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: (key: string) => values.get(key),
    entries: () => [...values].map(([key, value]) => ({ key, value })),
  };
}

describe("Functional Finn bounded transient evidence", () => {
  it("bounds giant object item traversal and never calls toJSON or getters", () => {
    const toJSON = vi.fn(() => {
      throw new Error("must not run");
    });
    const getter = vi.fn(() => "private getter value");
    const raw: Record<string, unknown> = { toJSON };
    Object.defineProperty(raw, "secret", { enumerable: true, get: getter });
    for (let index = 0; index < 10_000; index += 1) {
      raw[`field-${index}`] = `value-${index}`;
    }
    raw.self = raw;
    const content = serializeBoundedFunctionalFinnEvidence(raw, {
      maxBytes: 8 * 1024,
      maxItems: 32,
      maxDepth: 4,
    });
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(() => JSON.parse(content)).not.toThrow();
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(content).not.toContain("value-9999");
  });

  it("returns bounded valid evidence for cycles, accessors, and hostile enumeration", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(serializeBoundedFunctionalFinnEvidence(cyclic)).toContain("[Circular]");

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
      },
    );
    const content = serializeBoundedFunctionalFinnEvidence(hostile);
    expect(JSON.parse(content)).toEqual({ $error: "[Enumeration failed]" });
  });

  it("keeps user-confirmed evidence as raw bounded text rather than JSON materialization", () => {
    const store = new FunctionalFinnEvidenceStore(memoryStore());
    const observed = store.recordUserConfirmation({
      agentId: "finn",
      runId: "run",
      content: "The deployment is complete.",
      observedAt: 1,
    });
    expect(observed.content).toBe("The deployment is complete.");
  });

  it("has no same-process after-tool observation admission surface", () => {
    const store = new FunctionalFinnEvidenceStore(memoryStore());
    expect("recordToolObservation" in store).toBe(false);
  });
});
