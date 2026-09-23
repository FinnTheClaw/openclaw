import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import {
  ClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";

function binding(
  channelId: string,
  sessionId: string,
  detachedAt?: number,
): ClickClackDiscussionBinding {
  return {
    accountId: "main",
    agentId: "main",
    sessionId,
    serverBaseUrl: "https://clickclack.example",
    externalRef: "ref",
    externalUrl: "https://clickclack.example/room",
    workspaceRef: "team",
    workspaceId: "team",
    channelId,
    channelRouteId: "route",
    workspaceRouteId: "route",
    section: "Sessions",
    archived: false,
    label: "room",
    ...(detachedAt === undefined ? {} : { detachedAt }),
  };
}

function harness(seed: Array<[string, ClickClackDiscussionBinding]> = []) {
  const values = new Map<string, ClickClackDiscussionBinding>(seed);
  const runtime = {
    state: {
      openSyncKeyedStore: () => ({
        lookup: (key: string) => values.get(key),
        register: (key: string, value: ClickClackDiscussionBinding) => {
          values.set(key, value);
        },
        delete: (key: string) => values.delete(key),
        entries: () => Array.from(values, ([key, value]) => ({ key, value, createdAt: 0 })),
      }),
    },
    channel: { routing: { buildAgentSessionKey: () => "shared-side" } },
  } as unknown as PluginRuntime;
  return { store: new ClickClackDiscussionBindingStore(runtime), values };
}

describe("ST06 binding-index ownership", () => {
  it("01 simple set/get", () => {
    const { store } = harness();
    store.set("one", binding("a", "s1"));
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("one");
  });
  it("02 newer same-channel wins", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("a", "s2"));
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("new");
  });
  it("03 deleting older same-channel preserves newer", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("a", "s2"));
    store.delete("old");
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("new");
  });
  it("04 updating older same-channel preserves newer mapping", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("a", "s2"));
    store.set("old", binding("b", "s3"));
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("new");
    expect(store.getByChannel("https://clickclack.example", "b")?.sessionKey).toBe("old");
  });
  it("05 deleting newer removes its current channel mapping", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("a", "s2"));
    store.delete("new");
    expect(store.getByChannel("https://clickclack.example", "a")).toBeUndefined();
  });
  it("06 newer same-side-session wins", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("b", "s2"));
    expect(store.getByDiscussionSession("shared-side")?.sessionKey).toBe("new");
  });
  it("07 deleting older side-session preserves newer", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("b", "s2"));
    store.delete("old");
    expect(store.getByDiscussionSession("shared-side")?.sessionKey).toBe("new");
  });
  it("08 updating older side-session preserves newer owner when side key differs", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1"));
    store.set("new", binding("b", "s2"));
    store.set("old", binding("c", "s3"));
    expect(store.getByDiscussionSession("shared-side")?.sessionKey).toBe("old");
    store.delete("new");
    expect(store.getByDiscussionSession("shared-side")?.sessionKey).toBe("old");
  });
  it("09 unrelated channel and detached index remain", () => {
    const { store } = harness();
    store.set("old", binding("a", "s1", 10));
    store.set("other", binding("z", "s2", 20));
    store.delete("old");
    expect(store.getByChannel("https://clickclack.example", "z")?.sessionKey).toBe("other");
    expect(store.oldestDetached()?.sessionKey).toBe("other");
  });
  it("10 persisted initialization collision honors the last indexed owner", () => {
    const { store } = harness([
      ["old", binding("a", "s1")],
      ["new", binding("a", "s2")],
    ]);
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("new");
    store.delete("old");
    expect(store.getByChannel("https://clickclack.example", "a")?.sessionKey).toBe("new");
  });
});
