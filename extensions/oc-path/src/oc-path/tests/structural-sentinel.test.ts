// Focused regression cases for structural sentinel fields.
import { describe, expect, it } from "vitest";
import { emitMd } from "../emit.js";
import { emitJsonc } from "../jsonc/emit.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";

describe("structural sentinel emit guards", () => {
  it("rejects an exact Markdown frontmatter key in render mode", () => {
    const ast = parseMd("---\n" + REDACTED_SENTINEL + ": safe\n---\n").ast;
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("rejects an embedded Markdown frontmatter key in render mode", () => {
    const ast = parseMd("---\nprefix" + REDACTED_SENTINEL + "suffix: safe\n---\n").ast;
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("rejects an exact Markdown heading even with an empty body", () => {
    const ast = parseMd("## " + REDACTED_SENTINEL + "\n").ast;
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("rejects an embedded Markdown heading with ordinary body text", () => {
    const ast = parseMd("## prefix" + REDACTED_SENTINEL + "suffix\nordinary body\n").ast;
    expect(() => emitMd(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("rejects an exact JSONC root object key in render mode", () => {
    const ast = parseJsonc('{ "' + REDACTED_SENTINEL + '": 1 }').ast;
    expect(() => emitJsonc(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("rejects an embedded JSONC nested object key in render mode", () => {
    const ast = parseJsonc('{ "outer": [{ "prefix' + REDACTED_SENTINEL + 'suffix": null }] }').ast;
    expect(() => emitJsonc(ast, { mode: "render" })).toThrow(OcEmitSentinelError);
  });

  it("preserves pre-existing Markdown frontmatter-key bytes on round-trip", () => {
    const raw = "---\n" + REDACTED_SENTINEL + ": safe\n---\n";
    expect(emitMd(parseMd(raw).ast)).toBe(raw);
  });

  it("preserves pre-existing Markdown heading bytes on round-trip", () => {
    const raw = "## prefix" + REDACTED_SENTINEL + "suffix\r\n\r\nbody\r\n";
    expect(emitMd(parseMd(raw).ast)).toBe(raw);
  });

  it("preserves pre-existing JSONC key bytes on round-trip", () => {
    const raw = '{ // retained\n "' + REDACTED_SENTINEL + '": true\n}\n';
    expect(emitJsonc(parseJsonc(raw).ast)).toBe(raw);
  });

  it("renders ordinary Markdown and JSONC structural names", () => {
    const md = emitMd(parseMd("---\nname: safe\n---\n\n## Heading\nbody").ast, {
      mode: "render",
    });
    const jsonc = emitJsonc(parseJsonc('{ "safe": { "nested": true } }').ast, {
      mode: "render",
    });
    expect(md).toContain("name: safe");
    expect(md).toContain("## Heading");
    expect(JSON.parse(jsonc)).toEqual({ safe: { nested: true } });
  });
});
