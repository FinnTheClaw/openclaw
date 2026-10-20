import path from "node:path";
import { describe, expect, it } from "vitest";
import { shouldSkipRootMemoryAuxiliaryPath } from "./root-memory-files.js";

describe("staged dreaming recall isolation", () => {
  const workspaceDir = "/workspace/finn";
  it.each(["memory/dreaming/light", "memory/dreaming/light/2026-10-19.md"])(
    "does not index staged candidates: %s",
    (relative) => {
      expect(
        shouldSkipRootMemoryAuxiliaryPath({
          workspaceDir,
          absPath: path.join(workspaceDir, relative),
        }),
      ).toBe(true);
    },
  );
  it.each([
    "MEMORY.md",
    "memory/2026-10-19.md",
    "memory/dreaming/deep/2026-10-19.md",
    "memory/dreaming/rem/2026-10-19.md",
    "memory/dreaming/light-notes.md",
  ])("retains authored and reviewed memory: %s", (relative) => {
    expect(
      shouldSkipRootMemoryAuxiliaryPath({
        workspaceDir,
        absPath: path.join(workspaceDir, relative),
      }),
    ).toBe(false);
  });
  it("does not classify a foreign workspace by substring", () => {
    expect(
      shouldSkipRootMemoryAuxiliaryPath({
        workspaceDir,
        absPath: "/workspace/other/memory/dreaming/light/notes.md",
      }),
    ).toBe(false);
  });
});
