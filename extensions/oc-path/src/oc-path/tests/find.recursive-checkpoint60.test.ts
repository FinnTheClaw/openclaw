// Checkpoint 60: recursive wildcard paths must be complete, concrete, and unique.
import { describe, expect, it } from "vitest";
import { findOcPaths } from "../find.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { formatOcPath, parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { type OcAst, resolveOcPath } from "../universal.js";
import { parseYaml } from "../yaml/parse.js";

function expectConcretePaths(ast: OcAst, pattern: string, expected: readonly string[]): void {
  const matches = findOcPaths(ast, parseOcPath(pattern));
  const paths = matches.map(({ path }) => formatOcPath(path));
  expect(paths.toSorted()).toEqual([...expected].toSorted());
  expect(new Set(paths).size).toBe(paths.length);
  for (const result of matches) {
    expect(resolveOcPath(ast, result.path)).toEqual(result.match);
  }
}

const json = parseJsonc(
  JSON.stringify({ name: "top", child: { name: "nested", deep: { name: "deep" } } }),
).ast;

const yaml = parseYaml("name: top\nchild:\n  name: nested\n  deep:\n    name: deep\n").ast;

describe("checkpoint 60 recursive wildcard regression", () => {
  it("CP60-PATH01 terminal ** emits each JSONC path once, including the root", () => {
    expectConcretePaths(json, "oc://config.jsonc/**", [
      "oc://config.jsonc",
      "oc://config.jsonc/name",
      "oc://config.jsonc/child",
      "oc://config.jsonc/child.name",
      "oc://config.jsonc/child.deep",
      "oc://config.jsonc/child.deep.name",
    ]);
  });

  it("CP60-PATH02 **.name consumes zero segments at the JSONC root", () => {
    expectConcretePaths(json, "oc://config.jsonc/**.name", [
      "oc://config.jsonc/name",
      "oc://config.jsonc/child.name",
      "oc://config.jsonc/child.deep.name",
    ]);
  });

  it("CP60-PATH03 literal prefix plus ** covers zero and one nested depth", () => {
    expectConcretePaths(json, "oc://config.jsonc/child.**.name", [
      "oc://config.jsonc/child.name",
      "oc://config.jsonc/child.deep.name",
    ]);
  });

  it("CP60-PATH04 consecutive ** segments do not multiply concrete paths", () => {
    expectConcretePaths(json, "oc://config.jsonc/**.**.name", [
      "oc://config.jsonc/name",
      "oc://config.jsonc/child.name",
      "oc://config.jsonc/child.deep.name",
    ]);
  });

  it("CP60-PATH05 YAML **.name has zero-depth and nested parity", () => {
    expectConcretePaths(yaml, "oc://workflow.yaml/**.name", [
      "oc://workflow.yaml/name",
      "oc://workflow.yaml/child.name",
      "oc://workflow.yaml/child.deep.name",
    ]);
  });

  it("CP60-PATH06 terminal YAML ** emits each resolved node once", () => {
    expectConcretePaths(yaml, "oc://workflow.yaml/**", [
      "oc://workflow.yaml",
      "oc://workflow.yaml/name",
      "oc://workflow.yaml/child",
      "oc://workflow.yaml/child.name",
      "oc://workflow.yaml/child.deep",
      "oc://workflow.yaml/child.deep.name",
    ]);
  });

  it("CP60-PATH07 JSONL keeps line addresses while recursing within line values", () => {
    const ast = parseJsonl('{"name":"first"}\n{"child":{"name":"second"}}\n').ast;
    expectConcretePaths(ast, "oc://events.jsonl/*/**.name", [
      "oc://events.jsonl/L1/name",
      "oc://events.jsonl/L2/child.name",
    ]);
  });

  it("CP60-PATH08 Markdown recursion finds the target across blocks", () => {
    const ast = parseMd(
      "## Boundaries\n\n- never: delete\n\n## Tools\n\n- send_email: enabled\n- search: enabled\n",
    ).ast;
    expectConcretePaths(ast, "oc://SOUL.md/**/send-email", ["oc://SOUL.md/tools/send-email"]);
  });

  it("CP60-PATH09 zero-depth expansion preserves slot shape and session scope", () => {
    const pattern = "oc://config.jsonc/child.**.name?session=run-1";
    const matches = findOcPaths(json, parseOcPath(pattern));
    expectConcretePaths(json, pattern, [
      "oc://config.jsonc/child.name?session=run-1",
      "oc://config.jsonc/child.deep.name?session=run-1",
    ]);
    for (const { path } of matches) {
      expect(path.item).toBeUndefined();
      expect(path.field).toBeUndefined();
      expect(path.session).toBe("run-1");
    }
  });

  it("CP60-PATH10 neighboring literal and * keep one-segment semantics", () => {
    expectConcretePaths(json, "oc://config.jsonc/child.name", ["oc://config.jsonc/child.name"]);
    expectConcretePaths(json, "oc://config.jsonc/*.name", ["oc://config.jsonc/child.name"]);
    expectConcretePaths(json, "oc://config.jsonc/child.*.name", [
      "oc://config.jsonc/child.deep.name",
    ]);
  });
});
