// Checkpoint-80 regression pack: real SQLite and explicit persistence fault injection.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
} from "./thread-bindings-store.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

type Manager = ReturnType<typeof createTelegramThreadBindingManager>;
type Binding = ReturnType<Manager["listBindings"]>[number];
type Store = PluginStateSyncKeyedStore<Binding>;
const cfg = { channels: { telegram: { token: "test-token" } } } as OpenClawConfig;
const session = "plugin-binding:fixture:old";
const replacement = "plugin-binding:fixture:new";

describe("telegram binding durable mutation order", () => {
  let state: OpenClawTestState;
  let sqlite: Store;
  let managers: Manager[];
  let registerFaultAt = 0;
  let deleteFaultAt = 0;
  let registerCalls = 0;
  let deleteCalls = 0;
  let faultAccount: string | undefined;

  function rows(accountId: string): Binding[] {
    return sqlite
      .entries()
      .map((entry) => entry.value)
      .filter((entry) => entry.accountId === accountId);
  }

  function faultedStore(): Store {
    return {
      ...sqlite,
      register(key, value) {
        if (!faultAccount || value.accountId === faultAccount) {
          registerCalls++;
          if (registerCalls === registerFaultAt) {
            throw new Error("injected register fault");
          }
        }
        return sqlite.register(key, value);
      },
      delete(key) {
        // Delete faults are call-indexed; a faulted call never reaches SQLite.
        if (!faultAccount) {
          deleteCalls++;
          if (deleteCalls === deleteFaultAt) {
            throw new Error("injected delete fault");
          }
        }
        return sqlite.delete(key);
      },
    };
  }

  function manager(accountId = "work", persist = true): Manager {
    const created = createTelegramThreadBindingManager({
      cfg,
      accountId,
      persist,
      enableSweeper: false,
    });
    managers.push(created);
    return created;
  }

  async function bind(accountId: string, conversationId: string, targetSessionKey = session) {
    return getSessionBindingService().bind({
      targetSessionKey,
      targetKind: "session",
      conversation: { channel: "telegram", accountId, conversationId },
      placement: "current",
    });
  }

  async function unbindConversation(accountId: string, conversationId: string) {
    return getSessionBindingService().unbind({
      bindingId: accountId + ":" + conversationId,
      reason: "fixture",
    });
  }

  beforeEach(async () => {
    managers = [];
    registerFaultAt = 0;
    deleteFaultAt = 0;
    registerCalls = 0;
    deleteCalls = 0;
    faultAccount = undefined;
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telegram-bindings-order-",
    });
    resetPluginStateStoreForTests({ closeDatabase: false });
    sqlite = createPluginStateSyncKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
    });
    sqlite.clear();
    const wrapper = faultedStore();
    setTelegramRuntime({
      state: {
        openSyncKeyedStore: (() => wrapper) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  });

  afterEach(async () => {
    for (const item of managers) {
      item.stop();
    }
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it("CP80-TB01 failed new bind leaves live and SQLite empty", async () => {
    const owner = manager();
    registerFaultAt = 1;
    await expect(bind("work", "one")).rejects.toThrow();
    expect(owner.getByConversationId("one")).toBeUndefined();
    expect(rows("work")).toEqual([]);
  });

  it("CP80-TB02 failed rebind keeps the old live and SQLite target", async () => {
    const owner = manager();
    await bind("work", "one");
    registerFaultAt = 2;
    await expect(bind("work", "one", replacement)).rejects.toThrow();
    expect(owner.getByConversationId("one")?.targetSessionKey).toBe(session);
    expect(rows("work")[0]?.targetSessionKey).toBe(session);
  });

  it("CP80-TB03 failed single unbind retains live and SQLite row", async () => {
    const owner = manager();
    await bind("work", "one");
    deleteFaultAt = 1;
    await expect(unbindConversation("work", "one")).rejects.toThrow();
    expect(owner.getByConversationId("one")?.targetSessionKey).toBe(session);
    expect(rows("work").map((row) => row.conversationId)).toEqual(["one"]);
  });

  it("CP80-TB04 failed first multi-delete retains every row", async () => {
    const owner = manager();
    await bind("work", "one");
    await bind("work", "two");
    deleteFaultAt = 1;
    await expect(
      getSessionBindingService().unbind({
        bindingId: "work:one",
        targetSessionKey: session,
        reason: "fixture",
      }),
    ).rejects.toThrow();
    expect(owner.listBySessionKey(session).map((row) => row.conversationId)).toEqual([
      "one",
      "two",
    ]);
    expect(rows("work").map((row) => row.conversationId)).toEqual(["one", "two"]);
  });

  it("CP80-TB05 failed later multi-delete retains only the committed subset", async () => {
    const owner = manager();
    await bind("work", "one");
    await bind("work", "two");
    deleteFaultAt = 2;
    await expect(
      getSessionBindingService().unbind({
        bindingId: "work:one",
        targetSessionKey: session,
        reason: "fixture",
      }),
    ).rejects.toThrow();
    expect(owner.listBySessionKey(session).map((row) => row.conversationId)).toEqual(["two"]);
    expect(rows("work").map((row) => row.conversationId)).toEqual(["two"]);
  });

  it("CP80-TB06 successful bind installs matching live and SQLite target", async () => {
    const owner = manager();
    await bind("work", "one");
    expect(owner.getByConversationId("one")?.targetSessionKey).toBe(session);
    expect(rows("work")[0]?.targetSessionKey).toBe(session);
  });

  it("CP80-TB07 successful unbind removes matching live and SQLite target", async () => {
    const owner = manager();
    await bind("work", "one");
    await unbindConversation("work", "one");
    expect(owner.getByConversationId("one")).toBeUndefined();
    expect(rows("work")).toEqual([]);
  });

  it("CP80-TB08 persist:false still changes only live state", async () => {
    const owner = manager("work", false);
    registerFaultAt = 1;
    deleteFaultAt = 1;
    await bind("work", "one");
    expect(owner.getByConversationId("one")).toBeDefined();
    await unbindConversation("work", "one");
    expect(owner.getByConversationId("one")).toBeUndefined();
    expect(rows("work")).toEqual([]);
    expect(registerCalls).toBe(0);
    expect(deleteCalls).toBe(0);
  });

  it("CP80-TB09 restart after failed unbind reloads the retained SQLite row", async () => {
    const owner = manager();
    await bind("work", "one");
    deleteFaultAt = 1;
    await expect(unbindConversation("work", "one")).rejects.toThrow();
    owner.stop();
    const reloaded = manager();
    expect(reloaded.getByConversationId("one")?.targetSessionKey).toBe(session);
    expect(rows("work")[0]?.targetSessionKey).toBe(session);
  });

  it("CP80-TB10 a fault scoped to one account does not change another account", async () => {
    const work = manager("work");
    const personal = manager("personal");
    await bind("personal", "same");
    faultAccount = "work";
    registerCalls = 0;
    registerFaultAt = 1;
    await expect(bind("work", "same")).rejects.toThrow();
    expect(work.getByConversationId("same")).toBeUndefined();
    expect(rows("work")).toEqual([]);
    expect(personal.getByConversationId("same")?.targetSessionKey).toBe(session);
    expect(rows("personal")[0]?.targetSessionKey).toBe(session);
  });
});
