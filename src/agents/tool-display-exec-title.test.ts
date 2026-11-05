import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-exec.js";
import { formatToolDetail, inferToolMetaFromArgsCore, resolveToolDisplay } from "./tool-display.js";

describe("execution purpose display", () => {
  it.each([
    ["git constructor", "run git constructor"],
    ["git toString", "run git toString"],
    ["npm constructor", "run npm constructor"],
    ["pnpm toString", "run pnpm toString"],
    ["git status", "check git status"],
    ["npm test", "run tests"],
    ["git frobnicate", "run git frobnicate"],
    ["npm frobnicate", "run npm frobnicate"],
  ])("keeps exec-summary lookups within own command keys for %s", (command, summary) => {
    const args = { command };
    for (const detailMode of ["explain", "raw"] as const) {
      const expected = detailMode === "raw" ? `${summary}, \`${command}\`` : summary;
      for (const getDetail of [
        () => resolveExecDetail(args, { detailMode }),
        () => formatToolDetail(resolveToolDisplay({ name: "exec", args, detailMode })),
        () => inferToolMetaFromArgsCore("exec", args, { detailMode }),
      ]) {
        let actual: unknown;
        try {
          actual = getDetail();
        } catch (error: unknown) {
          actual = error;
        }
        expect.soft(actual).toBe(expected);
      }
    }
  });

  it.each(["exec", "bash", "shell"])(
    "shows agent intent for %s without hiding raw commands",
    (name) => {
      const args = { command: "git status --short", title: "Checking\n repository changes" };
      expect(formatToolDetail(resolveToolDisplay({ name, args }))).toBe(
        "Checking repository changes",
      );
      expect(formatToolDetail(resolveToolDisplay({ name, args, detailMode: "raw" }))).toContain(
        "git status --short",
      );
    },
  );

  it("bounds and redacts execution titles while keeping untitled code activity meaningful", () => {
    const title = `Checking ${"x".repeat(150)}`;
    const token = `ghp_${"a".repeat(36)}`;
    expect(resolveExecDetail({ title, code: "return 1" })).toHaveLength(120);
    expect(resolveExecDetail({ title: `Reading token=${token}`, code: "return 1" })).not.toContain(
      token,
    );
    expect(
      resolveExecDetail({ title: "\u001b[31mChecking\u001b[0m\u0007", code: "return 1" }),
    ).toBe("Checking");
    expect(resolveExecDetail({ code: "return 1" })).toBe("run JavaScript");
    expect(resolveExecDetail({ code: "return 1", language: "typescript" })).toBe("run TypeScript");
    expect(resolveExecDetail({ title: " ", command: "git status" })).toContain("check git status");
  });
});
