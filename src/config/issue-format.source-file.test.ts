// Focused summary contract for the production config issue formatter.
import { describe, expect, it } from "vitest";
import { formatConfigIssueSummary } from "./issue-format.js";

describe("formatConfigIssueSummary sourceFile", () => {
  it("F11-01 prefixes a line from the summary sourceFile option", () => {
    expect(
      formatConfigIssueSummary([{ path: "gateway.bind", message: "bad", line: 3 }], {
        sourceFile: "settings.json",
      }),
    ).toBe("settings.json:3 — gateway.bind: bad");
  });

  it("F11-02 gives an issue-level sourceFile precedence", () => {
    expect(
      formatConfigIssueSummary(
        [{ path: "gateway.bind", message: "bad", line: 3, sourceFile: "override.json" }],
        { sourceFile: "settings.json" },
      ),
    ).toBe("override.json:3 — gateway.bind: bad");
  });

  it("F11-03 falls back when the issue-level sourceFile is blank", () => {
    expect(
      formatConfigIssueSummary(
        [{ path: "gateway.bind", message: "bad", line: 3, sourceFile: "  " }],
        { sourceFile: "settings.json" },
      ),
    ).toBe("settings.json:3 — gateway.bind: bad");
  });

  it("F11-04 omits location for a blank summary sourceFile", () => {
    expect(
      formatConfigIssueSummary([{ path: "gateway.bind", message: "bad", line: 3 }], {
        sourceFile: "  ",
      }),
    ).toBe("gateway.bind: bad");
  });

  it("F11-05 omits location when line is missing or nonpositive", () => {
    const issues = [
      { path: "one", message: "bad" },
      { path: "two", message: "bad", line: 0 },
      { path: "three", message: "bad", line: -1 },
    ];
    expect(formatConfigIssueSummary(issues, { sourceFile: "settings.json" })).toBe(
      "one: bad; two: bad; three: bad",
    );
  });

  it("F11-06 prefixes each visible issue with its own line", () => {
    expect(
      formatConfigIssueSummary(
        [
          { path: "one", message: "bad", line: 3 },
          { path: "two", message: "worse", line: 9 },
        ],
        { sourceFile: "settings.json" },
      ),
    ).toBe("settings.json:3 — one: bad; settings.json:9 — two: worse");
  });

  it("F11-07 preserves the exact hidden count at maxIssues one", () => {
    expect(
      formatConfigIssueSummary(
        [
          { path: "one", message: "bad", line: 3 },
          { path: "two", message: "bad", line: 4 },
          { path: "three", message: "bad", line: 5 },
        ],
        { sourceFile: "settings.json", maxIssues: 1 },
      ),
    ).toBe("settings.json:3 — one: bad; and 2 more");
  });

  it("F11-08 keeps an empty issue list null", () => {
    expect(formatConfigIssueSummary([], { sourceFile: "settings.json" })).toBeNull();
  });

  it("F11-09 sanitizes control and ANSI text in sourceFile", () => {
    expect(
      formatConfigIssueSummary([{ path: "one", message: "bad", line: 3 }], {
        sourceFile: "\x1b[31msettings\n.json\x1b[0m",
      }),
    ).toBe("settings\\n.json:3 — one: bad");
  });

  it("F11-10 preserves root normalization and no-source output", () => {
    expect(formatConfigIssueSummary([{ path: "", message: "bad", line: 3 }])).toBe("<root>: bad");
    expect(
      formatConfigIssueSummary([{ path: "", message: "bad", line: 3 }], {
        sourceFile: "settings.json",
        normalizeRoot: false,
      }),
    ).toBe("settings.json:3 — : bad");
  });
});
