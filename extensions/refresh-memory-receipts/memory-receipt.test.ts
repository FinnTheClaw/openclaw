import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { captureMemoryAttempt, memoryReceipt, memoryTarget } from "./memory-receipt.js";

const workspaces: string[] = [];
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-receipts-")));
  workspaces.push(root);
  return root;
}
afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});
function status(text: string) {
  const payload = text.split("\n")[1];
  if (payload === undefined) {
    throw new Error("Missing memory receipt payload");
  }
  return JSON.parse(payload) as { status: string; nativeToolError: boolean };
}

describe("native memory readback receipts", () => {
  it("resolves relative and absolute memory targets without claiming unrelated paths", () => {
    const root = workspace();
    expect(memoryTarget(root, { path: "MEMORY.md" })).toBe(join(root, "MEMORY.md"));
    expect(memoryTarget(root, { path: join(root, "memory", "daily.md") })).toBe(
      join(root, "memory", "daily.md"),
    );
    expect(memoryTarget(root, { path: "../MEMORY.md" })).toBeUndefined();
    expect(memoryTarget(root, { path: "notes.md" })).toBeUndefined();
    expect(memoryTarget(root, { path: "~/MEMORY.md" })).toBeUndefined();
  });

  it("distinguishes a matching write from bytes already present", () => {
    const root = workspace();
    const target = join(root, "MEMORY.md");
    const attempt = captureMemoryAttempt(root, target);
    writeFileSync(target, "durable fact\n");
    const args = { path: target, content: "durable fact\n" };
    expect(
      status(memoryReceipt({ workspace: root, target, toolName: "write", args, attempt })).status,
    ).toBe("match");
    const noOp = captureMemoryAttempt(root, target);
    expect(
      status(memoryReceipt({ workspace: root, target, toolName: "write", args, attempt: noOp }))
        .status,
    ).toBe("no-op");
  });

  it("detects a stale/failed write instead of treating native success text as proof", () => {
    const root = workspace();
    const target = join(root, "USER.md");
    writeFileSync(target, "old");
    const attempt = captureMemoryAttempt(root, target);
    const receipt = memoryReceipt({
      workspace: root,
      target,
      toolName: "write",
      args: { content: "new" },
      attempt,
    });
    expect(status(receipt).status).toBe("mismatch");
  });

  it("checks multi-edit intended bytes against original positions", () => {
    const root = workspace();
    const target = join(root, "MEMORY.md");
    writeFileSync(target, "alpha beta\n");
    const attempt = captureMemoryAttempt(root, target);
    const args = {
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "beta", newText: "gamma" },
      ],
    };
    writeFileSync(target, "beta gamma\n");
    expect(
      status(memoryReceipt({ workspace: root, target, toolName: "edit", args, attempt })).status,
    ).toBe("match");
    writeFileSync(target, "gamma beta\n");
    expect(
      status(memoryReceipt({ workspace: root, target, toolName: "edit", args, attempt })).status,
    ).toBe("mismatch");
  });

  it("leaves unsupported normalized edits and missing pre-state unverified", () => {
    const root = workspace();
    const target = join(root, "SOUL.md");
    writeFileSync(target, "old\r\n");
    const attempt = captureMemoryAttempt(root, target);
    writeFileSync(target, "new\r\n");
    const args = { edits: [{ oldText: "old", newText: "new" }] };
    expect(
      status(memoryReceipt({ workspace: root, target, toolName: "edit", args, attempt })).status,
    ).toBe("unverified");
    expect(status(memoryReceipt({ workspace: root, target, toolName: "edit", args })).status).toBe(
      "unverified",
    );
  });

  it("retains underlying error evidence even if desired bytes are present", () => {
    const root = workspace();
    const target = join(root, "MEMORY.md");
    writeFileSync(target, "present");
    const receipt = status(
      memoryReceipt({
        workspace: root,
        target,
        toolName: "write",
        args: { content: "present" },
        isError: true,
      }),
    );
    expect(receipt).toMatchObject({ status: "match", nativeToolError: true });
  });

  it("adds guidance before any tools and appends without altering native result blocks", async () => {
    const root = workspace();
    const on = vi.fn();
    const registerAgentToolResultMiddleware = vi.fn();
    plugin.register({
      on,
      registerAgentToolResultMiddleware,
      logger: { warn: vi.fn() },
    } as unknown as OpenClawPluginApi);
    const prompt = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    const before = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1];
    const registration = registerAgentToolResultMiddleware.mock.calls[0];
    if (!registration) {
      throw new Error("Missing result middleware registration");
    }
    const middleware = registration[0];
    const context = { runId: "run", workspaceDir: root };
    expect(
      prompt({ prompt: "remember this", messages: [] }, context).appendSystemContext,
    ).toContain("if no tool ran");
    const args = { path: "MEMORY.md", content: "remembered\n" };
    before({ toolName: "write", params: args, toolCallId: "call" }, context);
    writeFileSync(join(root, "MEMORY.md"), args.content);
    const nativeBlock = { type: "text", text: "Successfully wrote bytes" };
    const original = { content: [nativeBlock], details: { changed: true } };
    const returned = await middleware(
      { toolName: "write", toolCallId: "call", args, result: original },
      context,
    );
    expect(returned.result.content[0]).toBe(nativeBlock);
    expect(returned.result.details).toBe(original.details);
    expect(original.content).toEqual([nativeBlock]);
    expect(status(returned.result.content[1].text).status).toBe("match");
    expect(
      await middleware(
        { toolName: "exec", toolCallId: "shell", args: {}, result: original },
        context,
      ),
    ).toBeUndefined();
  });
});
