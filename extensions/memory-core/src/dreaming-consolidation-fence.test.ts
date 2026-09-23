import { describe, expect, it } from "vitest";
import { applyMemoryConsolidationPlan } from "./dreaming-consolidation.js";

const ticks = "`".repeat(3);
const fourTicks = "`".repeat(4);
const cases = [
  {
    name: "ST02-01 legitimate bullet merge",
    lines: ["# Memory", "- Prior"],
    prior: ["- Prior"],
    accepted: true,
  },
  {
    name: "ST02-02 triple-fenced matching code",
    lines: ["# Memory", ticks, "- Prior", ticks],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-03 language-tagged fence",
    lines: ["# Memory", ticks + "ts", "- Prior", ticks],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-04 quadruple-backtick fence",
    lines: ["# Memory", fourTicks + "ts", "- Prior", fourTicks],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-05 tilde fence",
    lines: ["# Memory", "~~~text", "- Prior", "~~~"],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-06 duplicate text inside and outside fence",
    lines: ["# Memory", ticks, "- Prior", ticks, "- Prior"],
    prior: ["- Prior"],
    accepted: true,
  },
  {
    name: "ST02-07 fenced continuation",
    lines: ["# Memory", ticks, "- Prior", "  continuation", ticks],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-08 unclosed fence",
    lines: ["# Memory", ticks + "txt", "- Prior"],
    prior: ["- Prior"],
    accepted: false,
  },
  {
    name: "ST02-09 superseded lineage outside fence",
    lines: [
      "# Memory",
      "<!-- openclaw-memory-lineage:older -->",
      "<!-- openclaw-memory-promotion:old -->",
      "- Prior",
    ],
    prior: ["- Prior"],
    accepted: true,
    lineageKey: "older",
  },
  {
    name: "ST02-10 unrelated valid addition",
    lines: ["# Memory", ticks, "- Prior", ticks],
    prior: [],
    accepted: true,
  },
] as const;

describe("memory consolidation excludes fenced prior entries", () => {
  it.each(cases)("$name", ({ lines, prior, accepted, ...rest }) => {
    const existingMemory = lines.join("\n");
    const operation = {
      candidateKey: "new",
      action:
        "lineageKey" in rest
          ? ("superseded" as const)
          : prior.length
            ? ("merged" as const)
            : ("added" as const),
      resultEntry: "- New fact",
      priorEntries: [...prior],
      ...("lineageKey" in rest ? { lineageKey: rest.lineageKey } : {}),
    };
    const applied = applyMemoryConsolidationPlan({
      existingMemory,
      plan: { operations: [operation] },
      nowMs: Date.UTC(2026, 8, 23),
      maxPriorEntryLossFraction: 1,
    });
    if (!accepted) {
      expect(applied).toBeNull();
      return;
    }
    expect(applied?.content).toContain("- New fact");
    if (
      lines.includes(ticks) ||
      lines.includes(ticks + "ts") ||
      lines.includes(ticks + "txt") ||
      lines.includes(fourTicks + "ts") ||
      lines.includes("~~~text")
    ) {
      const firstFence = lines.findIndex(
        (line) => line.startsWith(ticks) || line.startsWith(fourTicks) || line.startsWith("~~~"),
      );
      const fencedPrior = lines.slice(firstFence).includes("- Prior");
      if (fencedPrior) {
        expect(applied?.content).toContain(lines.slice(firstFence, firstFence + 3).join("\n"));
      }
    }
    if (prior.length > 0 && !lines.includes(ticks)) {
      expect(applied?.content).not.toContain("- Prior");
    }
  });
});
