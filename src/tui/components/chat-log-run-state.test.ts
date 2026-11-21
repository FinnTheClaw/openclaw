import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("ChatLog run state", () => {
  let chatLog: ChatLog;
  beforeEach(() => {
    chatLog = new ChatLog(40);
  });
  const render = () => normalizeTestText(chatLog.render(120).join("\n"));
  function expectOrder(rendered: string, first: string, second: string) {
    expect(rendered.indexOf(first)).toBeLessThan(rendered.indexOf(second));
  }
  function addNotices(count: number) {
    for (let index = 0; index < count; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
  }
  it("keeps revised snapshots scoped to their own concurrent assistant run", () => {
    chatLog.updateAssistant("Obsolete first", "run-first");
    chatLog.updateAssistant("Preserved second", "run-second");
    chatLog.startTool("first-tool", "read_file", { path: "first.txt" }, "run-first");
    chatLog.updateAssistant("Revised first", "run-first");
    chatLog.updateAssistant("Preserved second\n\nSecond continuation", "run-second");

    const rendered = render();
    expect(rendered).not.toContain("Obsolete first");
    for (const text of ["Revised first", "Preserved second", "Second continuation"]) {
      expect(rendered.split(text)).toHaveLength(2);
    }
    expectOrder(rendered, "Preserved second", "Second continuation");
  });

  it("anchors a delayed prompt before the surviving streaming reply after pruning", () => {
    chatLog = new ChatLog(20);
    chatLog.finalizeAssistant("Evicted reply.", "old-run");
    chatLog.updateAssistant("Surviving reply.", "run");
    addNotices(18);
    chatLog.startTool("tool", "read_file", { path: "active.txt" });
    chatLog.addLiveUser("Delayed prompt.", { messageId: "user", runId: "run" });
    const rendered = render();
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Evicted reply.");
    expectOrder(rendered, "Delayed prompt.", "Surviving reply.");
    expectOrder(rendered, "Surviving reply.", "Read File");
  });

  it("deduplicates authoritative user events and adopts the matching pending prompt", () => {
    chatLog.addPendingUser("local-send", "Persisted prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");
    const identity = { messageId: "shared-user", sendId: "local-send", runId: "shared-run" };
    chatLog.addLiveUser("Persisted prompt.", identity);
    chatLog.addLiveUser("Persisted prompt.", identity);

    expect(render()).toContain("Persisted prompt.");
    const roles = chatLog.children.map((c) =>
      c instanceof MarkdownMessageComponent ? c.role : c.constructor.name,
    );
    expect(roles).toEqual(["user", "assistant"]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("preserves a different pending prompt when another client uses the same run", () => {
    chatLog.addPendingUser("shared-run", "My local steering prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");

    const identity = { messageId: "user", runId: "shared-run", sendId: "remote-send" };
    chatLog.addLiveUser("Another client's persisted prompt.", identity);

    const rendered = render();
    expect(rendered).toContain("My local steering prompt.");
    expect(rendered).toContain("Another client's persisted prompt.");
    expectOrder(rendered, "Another client's persisted prompt.", "Already streaming.");
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("re-keys a pending user in place without moving its position", () => {
    chatLog.addPendingUser("local", "queued hello");
    chatLog.updateAssistant("hi there", "r-accepted");
    chatLog.rekeyPendingUser("local", "r-accepted");

    expectOrder(render(), "queued hello", "hi there");
    chatLog.dropPendingUser("r-accepted");
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
      "MarkdownMessageComponent",
      "ToolExecutionComponent",
      "MarkdownMessageComponent",
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
      "MarkdownMessageComponent",
      "MarkdownMessageComponent",
      "ToolExecutionComponent",
      "MarkdownMessageComponent",
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
