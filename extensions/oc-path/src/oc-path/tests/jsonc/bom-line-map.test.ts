import { describe, expect, it } from "vitest";
import { MAX_JSONC_INPUT_BYTES, parseJsonc } from "../../jsonc/parse.js";

describe("parseJsonc BOM line map", () => {
  it.each(["", "\uFEFF"])("keeps structural line locations with prefix %j", (prefix) => {
    const raw = prefix + '{\n"x":1}';
    expect(parseJsonc(raw)).toEqual({
      kind: "jsonc",
      raw,
      root: {
        kind: "object",
        line: 1,
        entries: [{ key: "x", line: 2, value: { kind: "number", value: 1, line: 2 } }],
      },
    });
  });
  it("retains BOM bytes and refuses input beyond the byte cap", () => {
    const exact = '\uFEFF"' + "a".repeat(MAX_JSONC_INPUT_BYTES - 5) + '"';
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_JSONC_INPUT_BYTES);
    expect(parseJsonc(exact).root?.kind).toBe("string");
    expect(parseJsonc(exact + "a")).toMatchObject({
      root: null,
      oversizedInputBytes: MAX_JSONC_INPUT_BYTES + 1,
    });
  });
});
