// Focused BOM offset contract for the production JSONC parser.
import { describe, expect, it } from "vitest";
import { MAX_JSONC_INPUT_BYTES, parseJsonc } from "../../jsonc/parse.js";

describe("parseJsonc BOM line map", () => {
  it("F07-01 keeps unprefixed one-line object locations", () => {
    expect(parseJsonc('{"x":1}').ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", line: 1, value: { kind: "number", value: 1, line: 1 } }],
    });
  });

  it("F07-02 keeps BOM-prefixed one-line object locations", () => {
    expect(parseJsonc('\uFEFF{"x":1}').ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", line: 1, value: { kind: "number", value: 1, line: 1 } }],
    });
  });

  it("F07-03 maps an LF-separated key and value to line two", () => {
    expect(parseJsonc('\uFEFF{\n"x":1}').ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", line: 2, value: { kind: "number", value: 1, line: 2 } }],
    });
  });

  it("F07-04 maps a CRLF-separated key and value to line two", () => {
    expect(parseJsonc('\uFEFF{\r\n"x":1}').ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", line: 2, value: { kind: "number", value: 1, line: 2 } }],
    });
  });

  it("F07-05 counts blank and comment lines after a BOM", () => {
    const { ast, diagnostics } = parseJsonc('\uFEFF{\n\n// note\n"x":1}');
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [{ key: "x", line: 4, value: { kind: "number", value: 1, line: 4 } }],
    });
  });

  it("F07-06 maps nested object, array, and element lines", () => {
    const { ast, diagnostics } = parseJsonc('\uFEFF{\n"a": {\n"b": [\n1,\n2\n]\n}\n}');
    expect(diagnostics).toEqual([]);
    expect(ast.root).toEqual({
      kind: "object",
      line: 1,
      entries: [
        {
          key: "a",
          line: 2,
          value: {
            kind: "object",
            line: 2,
            entries: [
              {
                key: "b",
                line: 3,
                value: {
                  kind: "array",
                  line: 3,
                  items: [
                    { kind: "number", value: 1, line: 4 },
                    { kind: "number", value: 2, line: 5 },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("F07-07 maps a malformed second-line property error", () => {
    const { ast, diagnostics } = parseJsonc('\uFEFF{\n"x": }\n');
    expect(ast.root).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({ line: 2, severity: "error", code: "OC_JSONC_PARSE_FAILED" }),
    ]);
  });

  it("F07-08 maps trailing input warning without changing its severity", () => {
    const { diagnostics } = parseJsonc("\uFEFF1\nbad");
    expect(diagnostics).toEqual([
      expect.objectContaining({ line: 2, severity: "warning", code: "OC_JSONC_TRAILING_INPUT" }),
    ]);
  });

  it("F07-09 retains the original BOM and line breaks in ast.raw", () => {
    const raw = '\uFEFF{\n"x":1}\n';
    const { ast, diagnostics } = parseJsonc(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.raw).toBe(raw);
    expect(ast.raw.charCodeAt(0)).toBe(0xfeff);
  });

  it("F07-10 counts BOM bytes at exact and over-cap boundaries", () => {
    const exact = '\uFEFF"' + "a".repeat(MAX_JSONC_INPUT_BYTES - 5) + '"';
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_JSONC_INPUT_BYTES);
    const accepted = parseJsonc(exact);
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.ast.root?.kind).toBe("string");
    const rejected = parseJsonc(exact + "a");
    expect(rejected.ast.root).toBeNull();
    expect(rejected.diagnostics).toEqual([
      expect.objectContaining({ code: "OC_JSONC_INPUT_TOO_LARGE", severity: "error" }),
    ]);
  });
});
