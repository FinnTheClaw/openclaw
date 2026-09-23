import { describe, expect, it } from "vitest";
import { analyzeArgvCommand } from "./exec-argv-analysis.js";

describe("checkpoint-90 argv positional preservation", () => {
  it.each([
    { name: "empty-executable-reject", argv: [""], ok: false },
    { name: "whitespace-executable-reject", argv: ["  ", "x"], ok: false },
    { name: "interior-empty-argument", argv: ["/bin/echo", "", "x"], ok: true },
    { name: "trailing-empty-argument", argv: ["/bin/echo", "x", ""], ok: true },
    { name: "whitespace-argument", argv: ["/bin/echo", "   ", "x"], ok: true },
    { name: "two-consecutive-empty-arguments", argv: ["/bin/echo", "", "", "x"], ok: true },
    { name: "normal-argv-control", argv: ["/bin/echo", "x"], ok: true },
    { name: "shell-c-blank-payload", argv: ["/bin/sh", "-c", ""], ok: true },
    { name: "allowlist-analysis-equals-exec-argv", argv: ["/usr/bin/env", "", "x"], ok: true },
    {
      name: "argument-count-position-preserved",
      argv: ["/bin/echo", "", "middle", "  ", ""],
      ok: true,
    },
  ])("$name", ({ argv, ok }) => {
    const analysis = analyzeArgvCommand({ argv, platform: "linux" });
    expect(analysis.ok).toBe(ok);
    if (ok) {
      expect(analysis.segments).toHaveLength(1);
      expect(analysis.segments[0]?.argv).toEqual(argv);
      expect(analysis.segments[0]?.sourceArgv).toEqual(argv);
      expect(analysis.segments[0]?.resolution?.effectiveArgv).toEqual(argv);
    } else {
      expect(analysis).toEqual({ ok: false, reason: "empty argv", segments: [] });
    }
  });
});
