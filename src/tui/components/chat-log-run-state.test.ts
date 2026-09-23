// Covers canonical assistant-run ownership and live transcript identity.
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { readTuiSessionUserMessage } from "../tui-session-events.js";
import { ChatLog } from "./chat-log.js";

describe("ChatLog run state", () => {
  it("keeps revised snapshots scoped to their own concurrent assistant run", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Obsolete first reply.", "run-first");
    chatLog.updateAssistant("Preserved second reply.", "run-second");
    chatLog.startTool("first-tool", "read_file", { path: "first.txt" }, "run-first");
    chatLog.updateAssistant("Revised first reply.", "run-first");
    chatLog.updateAssistant("Preserved second reply.\n\nSecond continuation.", "run-second");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Obsolete first reply.");
    expect(rendered.split("Revised first reply.")).toHaveLength(2);
    expect(rendered.split("Preserved second reply.")).toHaveLength(2);
    expect(rendered.split("Second continuation.")).toHaveLength(2);
    expect(rendered.indexOf("Preserved second reply.")).toBeLessThan(
      rendered.indexOf("Second continuation."),
    );
  });

  it("infers tool ownership from the only streaming run after another run finalizes", () => {
    const chatLog = new ChatLog(40);

    chatLog.finalizeAssistant("Completed first reply.", "run-first");
    chatLog.updateAssistant("Streaming second reply.", "run-second");
    chatLog.startTool("second-tool", "read_file", { path: "second.txt" });
    chatLog.addLiveUser("Delayed second prompt.", {
      messageId: "second-user",
      runId: "run-second",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.indexOf("Completed first reply.")).toBeLessThan(
      rendered.indexOf("Delayed second prompt."),
    );
    expect(rendered.indexOf("Delayed second prompt.")).toBeLessThan(
      rendered.indexOf("Streaming second reply."),
    );
    expect(rendered.indexOf("Streaming second reply.")).toBeLessThan(rendered.indexOf("Read File"));
  });

  it("keeps a replacement final reply anchored when its previous reply is pruned", () => {
    const chatLog = new ChatLog(20);

    chatLog.finalizeAssistant("Previous completed reply.", "run-replaced");
    for (let index = 0; index < 19; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
    chatLog.finalizeAssistant("Replacement completed reply.", "run-replaced");
    chatLog.addLiveUser("Delayed replacement prompt.", {
      messageId: "replacement-user",
      runId: "run-replaced",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Previous completed reply.");
    expect(rendered.indexOf("Delayed replacement prompt.")).toBeLessThan(
      rendered.indexOf("Replacement completed reply."),
    );
  });

  it("infers active tool ownership after another finalized run leaves scrollback", () => {
    const chatLog = new ChatLog(20);

    chatLog.finalizeAssistant("Evicted completed reply.", "run-evicted");
    chatLog.updateAssistant("Surviving streamed reply.", "run-active");
    for (let index = 0; index < 18; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
    chatLog.startTool("active-tool", "read_file", { path: "active.txt" });
    chatLog.addLiveUser("Delayed active prompt.", {
      messageId: "active-user",
      runId: "run-active",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Evicted completed reply.");
    expect(rendered.indexOf("Delayed active prompt.")).toBeLessThan(
      rendered.indexOf("Surviving streamed reply."),
    );
    expect(rendered.indexOf("Surviving streamed reply.")).toBeLessThan(
      rendered.indexOf("Read File"),
    );
  });

  it("deduplicates authoritative user events and adopts the matching pending prompt", () => {
    const chatLog = new ChatLog(40);
    chatLog.addPendingUser("local-send", "Persisted prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");
    const message = readTuiSessionUserMessage({
      message: {
        role: "user",
        content: "Persisted prompt.",
        __openclaw: {
          id: "shared-user",
          idempotencyKey: "local-send:user",
          runId: "shared-run",
        },
      },
    });
    expect(message).not.toBeNull();
    if (!message) {
      throw new Error("expected a persisted user message");
    }

    chatLog.addLiveUser(message.text, message);
    chatLog.addLiveUser(message.text, message);

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Persisted prompt.");
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "UserMessageComponent",
      "AssistantMessageComponent",
    ]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("preserves a different pending prompt when another client uses the same run", () => {
    const chatLog = new ChatLog(40);
    chatLog.addPendingUser("shared-run", "My local steering prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");

    chatLog.addLiveUser("Another client's persisted prompt.", {
      messageId: "shared-remote-user",
      runId: "shared-run",
      sendId: "remote-send",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("My local steering prompt.");
    expect(rendered).toContain("Another client's persisted prompt.");
    expect(rendered.indexOf("Another client's persisted prompt.")).toBeLessThan(
      rendered.indexOf("Already streaming."),
    );
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("deduplicates a replayed live prompt already loaded from authoritative history", () => {
    const chatLog = new ChatLog(40);
    chatLog.addUser("Loaded from history.", { messageId: "history-user" });

    chatLog.addLiveUser("Loaded from history.", {
      messageId: "history-user",
      runId: "history-run",
    });

    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "UserMessageComponent",
    ]);
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Loaded from history.");
  });

  it("re-keys a pending user in place without moving its position", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("local", "queued hello");
    chatLog.startAssistant("hi there", "r-accepted");

    expect(chatLog.rekeyPendingUser("local", "r-accepted")).toBe(true);

    const rendered = chatLog.render(120).join("\n");
    expect(rendered.indexOf("queued hello")).toBeLessThan(rendered.indexOf("hi there"));
    // The row is now addressable by the gateway-assigned runId.
    expect(chatLog.dropPendingUser("r-accepted")).toBe(true);
    expect(chatLog.countPendingUsers()).toBe(0);
  });
});

describe("R7-L07-11 tool starts freeze only their owning assistant run", () => {
  it("tui-tool-a-keeps-b", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const b = log.children[1];
    log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
  });

  it("tui-tool-b-keeps-a", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const a = log.children[0];
    log.startTool("B-tool", "read_file", { path: "b.txt" }, "B");
    expect(log.children[0]).toBe(a);
    expect(log.children).toHaveLength(3);
  });

  it("tui-ambiguous-tool-freezes-none", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const [a, b] = log.children;
    log.startTool("unknown-tool", "read_file", { path: "unknown.txt" });
    log.updateAssistant("A before.\nA after.", "A");
    log.updateAssistant("B before.\nB after.", "B");
    expect(log.children[0]).toBe(a);
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
  });

  it("tui-single-run-inference", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.startTool("A-tool", "read_file", { path: "a.txt" });
    log.updateAssistant("A before.\nA after.", "A");
    expect(log.children.map((child) => child.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    const rendered = normalizeTestText(log.render(120).join("\n"));
    expect(rendered.indexOf("A before.")).toBeLessThan(rendered.indexOf("Read File"));
    expect(rendered.indexOf("Read File")).toBeLessThan(rendered.indexOf("A after."));
  });

  it("tui-owned-cumulative-split", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    log.updateAssistant("A before.\nA after.", "A");
    expect(log.children.map((child) => child.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    const rendered = normalizeTestText(log.render(120).join("\n"));
    expect(rendered.split("A before.")).toHaveLength(2);
    expect(rendered.split("B before.")).toHaveLength(2);
    expect(rendered.split("A after.")).toHaveLength(2);
  });

  it("tui-peer-continuation", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const b = log.children[1];
    log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    log.updateAssistant("B before.\nB after.", "B");
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
    const rendered = normalizeTestText(log.render(120).join("\n"));
    expect(rendered.split("B before.")).toHaveLength(2);
    expect(rendered.split("B after.")).toHaveLength(2);
  });

  it("tui-peer-finalization", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const b = log.children[1];
    log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    log.finalizeAssistant("B final.", "B");
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
    const rendered = normalizeTestText(log.render(120).join("\n"));
    expect(rendered.split("B final.")).toHaveLength(2);
  });

  it("tui-repeated-tool-id", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const b = log.children[1];
    const tool = log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    const repeated = log.startTool("A-tool", "read_file", { path: "b.txt" }, "A");
    expect(repeated).toBe(tool);
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
  });

  it("tui-tool-result-isolation", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    const b = log.children[1];
    log.startTool("A-tool", "read_file", { path: "a.txt" }, "A");
    log.updateToolResult("A-tool", { content: [{ type: "text", text: "done" }] });
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(3);
    expect(normalizeTestText(log.render(120).join("\n"))).toContain("B before.");
  });

  it("tui-three-run-interleave", () => {
    const log = new ChatLog(40);
    log.updateAssistant("A before.", "A");
    log.updateAssistant("B before.", "B");
    log.updateAssistant("C before.", "C");
    const [a, b] = log.children;
    log.startTool("C-tool", "read_file", { path: "c.txt" }, "C");
    log.updateAssistant("A before.\nA after.", "A");
    log.updateAssistant("B before.\nB after.", "B");
    log.updateAssistant("C before.\nC after.", "C");
    expect(log.children[0]).toBe(a);
    expect(log.children[1]).toBe(b);
    expect(log.children).toHaveLength(5);
    const rendered = normalizeTestText(log.render(120).join("\n"));
    for (const text of [
      "A before.",
      "A after.",
      "B before.",
      "B after.",
      "C before.",
      "C after.",
    ]) {
      expect(rendered.split(text)).toHaveLength(2);
    }
  });
});
