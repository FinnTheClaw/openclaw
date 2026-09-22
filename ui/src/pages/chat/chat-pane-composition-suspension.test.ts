/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-composition.test/"} */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";

afterEach(async () => {
  await resetComposerFixture();
});

describe("CHAT-F1", () => {
  it.each([
    { id: "01 distinct presentation", value: "pending draft", mode: "hidden" },
    { id: "02 Unicode composition", value: "日本語の下書き", mode: "hidden" },
    { id: "03 cleared composition", value: "", mode: "hidden" },
    { id: "04 stale pane-key decoy", value: "new draft", mode: "decoy" },
    { id: "05 retained presentation switch", value: "new session draft", mode: "switch" },
    { id: "06 equal-key control", value: "single pane draft", mode: "same" },
    { id: "07 unchanged control", value: "saved", mode: "unchanged" },
    { id: "08 missing textarea control", value: "unused", mode: "missing" },
    { id: "09 visible control", value: "pending", mode: "visible" },
    { id: "10 repeated hide is idempotent", value: "once only", mode: "repeat" },
  ])("$id", async ({ value, mode }) => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { pane, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const lifecycle = pane as typeof pane & {
      paneId: string;
      presentationId: string;
      render: () => unknown;
    };
    lifecycle.paneId = "left";
    lifecycle.presentationId =
      mode === "same" ? "left" : JSON.stringify(["left", "session-current"]);
    lifecycle.render = () => null;
    state.chatMessage = "saved";
    state.handleChatDraftChange = vi.fn((next: string) => {
      state.chatMessage = next;
    });
    if (mode === "decoy" || mode === "switch") {
      const old = renderComposerFixture({
        paneId: mode === "decoy" ? lifecycle.paneId : JSON.stringify(["left", "session-old"]),
        draft: "stale draft",
      });
      expect(old.container.querySelector("textarea")?.value).toBe("stale draft");
    }
    if (mode !== "missing") {
      const { container, props } = renderComposerFixture({
        paneId: lifecycle.presentationId,
        draft: "saved",
        onDraftChange: state.handleChatDraftChange,
      });
      const textarea = container.querySelector("textarea")!;
      expect(getChatComposerState(lifecycle.presentationId).composerTextarea).toBe(textarea);
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = value;
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      expect(props.onDraftChange).not.toHaveBeenCalled();
    }
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await lifecycle.updateComplete;
    try {
      visibility = mode === "visible" ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      if (mode === "repeat") document.dispatchEvent(new Event("visibilitychange"));
      const changed = !["unchanged", "missing", "visible"].includes(mode);
      expect(state.handleChatDraftChange).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(state.chatMessage).toBe(changed ? value : "saved");
      if (changed) expect(state.handleChatDraftChange).toHaveBeenCalledWith(value);
    } finally {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await lifecycle.updateComplete;
      Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
      ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    }
  });
});
