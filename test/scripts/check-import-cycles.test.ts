import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  exportDeclarationHasRuntimeEdge,
  importDeclarationHasRuntimeEdge,
} from "../../scripts/check-import-cycles.ts";

function declaration(source: string): ts.Statement {
  return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true).statements[0]!;
}

describe("check-import-cycles runtime edges", () => {
  it("retains inline type-only module resolution edges", () => {
    expect(
      importDeclarationHasRuntimeEdge(
        declaration('import { type T } from "./b.js";') as ts.ImportDeclaration,
      ),
    ).toBe(true);
    expect(
      importDeclarationHasRuntimeEdge(
        declaration('import type { T } from "./b.js";') as ts.ImportDeclaration,
      ),
    ).toBe(false);
    expect(
      exportDeclarationHasRuntimeEdge(
        declaration('export { type T } from "./b.js";') as ts.ExportDeclaration,
      ),
    ).toBe(true);
    expect(
      exportDeclarationHasRuntimeEdge(
        declaration('export type { T } from "./b.js";') as ts.ExportDeclaration,
      ),
    ).toBe(false);
    expect(
      ts.transpileModule('import { type T } from "./b.js";', {
        compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
      }).outputText,
    ).toContain('import {} from "./b.js";');
  });
});
