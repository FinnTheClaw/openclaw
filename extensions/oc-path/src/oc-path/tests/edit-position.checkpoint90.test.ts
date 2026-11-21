// Checkpoint-90 OC-path position-aware Markdown edits (ten primary cases).
import { describe, expect, it } from "vitest";
import type { MdAst } from "../ast.js";
import { setMdOcPath } from "../edit.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";

const timeoutPath = parseOcPath("oc://AGENTS.md/boundaries/timeout/timeout");

function set(ast: MdAst, path: ReturnType<typeof parseOcPath>, value: string): MdAst {
  return setMdOcPath(ast, path, value);
}

function timeoutValue(ast: MdAst): string | undefined {
  const reparsed = parseMd(ast.raw);
  return reparsed.blocks[0]?.items.find((item) => item.slug === "timeout")?.kv?.value;
}

describe("checkpoint-90 OC-path selected Markdown list-item edits", () => {
  it("CP90-OC01 edits the real item after a fenced example", () => {
    const raw = "## Boundaries\n\n```md\n- timeout: example\n```\n\n- timeout: 5\n";
    const ast = set(parseMd(raw), timeoutPath, "30");
    expect(ast.raw).toContain("```md\n- timeout: example\n```");
    expect(ast.raw).toContain("\n- timeout: 30\n");
    expect(timeoutValue(ast)).toBe("30");
  });

  it("CP90-OC02 leaves an earlier indented-code example intact", () => {
    const raw = "## Boundaries\n\n    - timeout: example\n\n- timeout: 5\n";
    const ast = set(parseMd(raw), timeoutPath, "31");
    expect(ast.raw).toContain("    - timeout: example");
    expect(ast.raw).toContain("\n- timeout: 31\n");
    expect(timeoutValue(ast)).toBe("31");
  });

  it("CP90-OC03 changes only the first of two addressable duplicate keys", () => {
    const raw = "## Boundaries\n\n- timeout: 5\n- timeout: 6\n";
    const ast = set(parseMd(raw), timeoutPath, "32");
    expect(ast.raw).toContain("- timeout: 32\n- timeout: 6");
    const items = parseMd(ast.raw).blocks[0]?.items;
    expect(items?.map((item) => item.kv?.value)).toEqual(["32", "6"]);
  });

  it("CP90-OC04 preserves a plus-list marker", () => {
    const ast = set(parseMd("## Boundaries\n\n+ timeout: 5\n"), timeoutPath, "33");
    expect(ast.raw).toContain("+ timeout: 33");
    expect(timeoutValue(ast)).toBe("33");
  });

  it("CP90-OC05 preserves a star-list marker", () => {
    const ast = set(parseMd("## Boundaries\n\n* timeout: 5\n"), timeoutPath, "34");
    expect(ast.raw).toContain("* timeout: 34");
    expect(timeoutValue(ast)).toBe("34");
  });

  it("CP90-OC06 preserves an ordered dot marker", () => {
    const ast = set(parseMd("## Boundaries\n\n1. timeout: 5\n"), timeoutPath, "35");
    expect(ast.raw).toContain("1. timeout: 35");
    expect(timeoutValue(ast)).toBe("35");
  });

  it("CP90-OC07 preserves an ordered parenthesis marker", () => {
    const ast = set(parseMd("## Boundaries\n\n2) timeout: 5\n"), timeoutPath, "36");
    expect(ast.raw).toContain("2) timeout: 36");
    expect(timeoutValue(ast)).toBe("36");
  });

  it("CP90-OC08 edits a nested bullet at its own source line", () => {
    const raw = "## Boundaries\n\n- group\n  - timeout: 5\n- other: kept\n";
    const ast = set(parseMd(raw), timeoutPath, "37");
    expect(ast.raw).toContain("- group\n  - timeout: 37\n- other: kept");
    expect(timeoutValue(ast)).toBe("37");
  });

  it("CP90-OC09 refreshes line positions between edits when the first inserts a line", () => {
    const raw = "## Boundaries\n\n- first: 1\n- timeout: 5\n";
    const firstPath = parseOcPath("oc://AGENTS.md/boundaries/first/first");
    const first = set(parseMd(raw), firstPath, "10\n");
    const second = set(first, timeoutPath, "38");
    expect(second.raw).toContain("- first: 10\n\n- timeout: 38");
    expect(timeoutValue(second)).toBe("38");
  });

  it("CP90-OC10 writes replacement syntax literally and leaves its neighbor alone", () => {
    const raw = "## Boundaries\n\n- timeout: 5\n- other: kept\n";
    const ast = set(parseMd(raw), timeoutPath, "$&/$1/$$");
    expect(ast.raw).toContain("- timeout: $&/$1/$$\n- other: kept");
    expect(timeoutValue(ast)).toBe("$&/$1/$$");
  });
});
