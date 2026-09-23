// OC Path tests cover edit plugin behavior.
import { describe, expect, it } from "vitest";
import { setMdOcPath as setOcPath } from "../edit.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";

describe("setOcPath — frontmatter", () => {
  it("replaces a frontmatter value", () => {
    const raw = `---
name: github
description: old desc
---

Body.
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/description"), "new desc");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("description: new desc");
      expect(r.ast.raw).not.toContain("old desc");
    }
  });

  it("reports unresolved when the key is missing", () => {
    const { ast } = parseMd("---\nname: x\n---\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/nope"), "x");
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("quotes frontmatter values containing structural chars", () => {
    const { ast } = parseMd("---\nx: a\n---\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/x"), "has: colon");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain('x: "has: colon"');
    }
  });
});

describe("setOcPath — item kv field", () => {
  it("replaces an item kv value and reflects it in the rebuilt body", () => {
    const raw = `## Boundaries

- enabled: true
- timeout: 5
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries/timeout/timeout"), "30");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("- timeout: 30");
      expect(r.ast.raw).toContain("- enabled: true");
    }
  });

  it("reports no-item-kv for an item without kv shape", () => {
    const raw = `## Boundaries

- plain bullet
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(
      ast,
      parseOcPath("oc://AGENTS.md/boundaries/plain-bullet/plain-bullet"),
      "x",
    );
    expect(r).toEqual({ ok: false, reason: "no-item-kv" });
  });

  it("reports unresolved when section/item is missing", () => {
    const { ast } = parseMd("## Other\n\n- foo: bar\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/missing/foo/foo"), "x");
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("reports not-writable for section-only addresses", () => {
    const { ast } = parseMd("## Boundaries\n\n- enabled: true\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries"), "x");
    expect(r).toEqual({ ok: false, reason: "not-writable" });
  });
});

describe("setOcPath — literal item replacement tokens", () => {
  const raw = "## Boundaries\n\n- enabled: old\n- timeout: 5\n";
  const enabledPath = parseOcPath("oc://AGENTS.md/boundaries/enabled/enabled");
  const timeoutPath = parseOcPath("oc://AGENTS.md/boundaries/timeout/timeout");

  it.each([
    { name: "whole match", value: "$&" },
    { name: "first capture", value: "$1" },
    { name: "preceding text", value: "$`" },
    { name: "following text", value: "$'" },
    { name: "dollar escape", value: "$$" },
    { name: "embedded whole match", value: "pre$&post" },
    { name: "embedded first capture", value: "pre$1post" },
    { name: "mixed tokens", value: "$&/$1/$`/$'/$$" },
    { name: "Unicode around token", value: "λ$&🙂" },
  ])("writes $name as literal Markdown", ({ value }) => {
    const result = setOcPath(parseMd(raw).ast, enabledPath, value);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ast.raw).toContain(`- enabled: ${value}\n- timeout: 5`);
    expect(result.ast.raw.match(/^- enabled:/gm)).toHaveLength(1);
    expect(result.ast.raw.match(/^- timeout:/gm)).toHaveLength(1);
    const reparsed = parseMd(result.ast.raw).ast;
    expect(reparsed.blocks[0]?.items[0]?.kv?.value).toBe(value);
    expect(reparsed.blocks[0]?.items[1]?.kv?.value).toBe("5");
  });

  it("preserves two sequential literal-token edits and neighboring lines", () => {
    const first = setOcPath(parseMd(raw).ast, enabledPath, "$&");
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = setOcPath(first.ast, timeoutPath, "$1");
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.ast.raw).toContain("- enabled: $&\n- timeout: $1");
    const reparsed = parseMd(second.ast.raw).ast;
    expect(reparsed.blocks[0]?.items[0]?.kv?.value).toBe("$&");
    expect(reparsed.blocks[0]?.items[1]?.kv?.value).toBe("$1");
  });
});

describe("setOcPath — sentinel guard (defense-in-depth)", () => {
  // The JSONC + JSONL paths reject sentinel-bearing values at the
  // substrate boundary; the md path was deferring entirely to round-trip
  // echo through emitMd, which acceptPreExistingSentinel:true skips.
  // Closing the gap keeps F9 (formatter sentinel guard) symmetric across
  // all three kinds.
  it("rejects bare sentinel on frontmatter value", () => {
    const { ast } = parseMd("---\nname: x\n---\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/name"), REDACTED_SENTINEL),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects substring-embedded sentinel on item kv", () => {
    const { ast } = parseMd("## Boundaries\n\n- enabled: true\n");
    expect(() =>
      setOcPath(
        ast,
        parseOcPath("oc://AGENTS.md/boundaries/enabled/enabled"),
        `prefix${REDACTED_SENTINEL}suffix`,
      ),
    ).toThrow(OcEmitSentinelError);
  });
});
