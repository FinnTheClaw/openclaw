import path from "node:path";
import ts from "typescript";
import { propagateLocalAuthorityAliases } from "./governor-production-authority-aliases.mjs";
import {
  ALLOWED_AUTHORITY_BEARING_EXPORTS,
  AUTHORITY_KERNEL_MARKERS,
  collectGovernorTarEntryErrors,
  FORBIDDEN_AUTHORITY_EXPORTS,
  FORBIDDEN_TEST_FACTORY_MARKERS,
} from "./governor-production-authority-rules.mjs";
// This is a direct package-surface inventory, not whole-program call-taint analysis.
// Same-process semantic wrappers remain for the later OS-boundary hardening slice.

const FORBIDDEN_EXPORTS = FORBIDDEN_AUTHORITY_EXPORTS;
function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
function hasDefaultModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}
function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function collectBindingOrigins(name, expression, selectors, defaults, origins) {
  if (ts.isIdentifier(name)) {
    origins.set(name.text, { expression, selectors, defaults });
    return;
  }
  for (let index = 0; index < name.elements.length; index += 1) {
    const element = name.elements[index];
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    if (element.dotDotDotToken) {
      collectBindingOrigins(element.name, expression, selectors, defaults, origins);
      continue;
    }
    const selector = ts.isArrayBindingPattern(name)
      ? index
      : element.propertyName &&
          (ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteralLike(element.propertyName) ||
            ts.isNumericLiteral(element.propertyName))
        ? element.propertyName.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
    collectBindingOrigins(
      element.name,
      expression,
      selector === undefined ? selectors : [...selectors, selector],
      element.initializer ? [...defaults, element.initializer] : defaults,
      origins,
    );
  }
}

function collectExportedObjectAuthorityReferences(
  expression,
  forbiddenReferences,
  topLevelInitializers,
  visited = new Set(),
) {
  if (ts.isParenthesizedExpression(expression)) {
    collectExportedObjectAuthorityReferences(
      expression.expression,
      forbiddenReferences,
      topLevelInitializers,
      visited,
    );
    return;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectExportedObjectAuthorityReferences(
          ts.isSpreadElement(element) ? element.expression : element,
          forbiddenReferences,
          topLevelInitializers,
          visited,
        );
      }
    }
    return;
  }
  if (!ts.isObjectLiteralExpression(expression)) {
    if (ts.isIdentifier(expression)) {
      if (FORBIDDEN_EXPORTS.has(expression.text)) {
        forbiddenReferences.add(expression.text);
      }
      if (!visited.has(expression.text)) {
        const initializer = topLevelInitializers.get(expression.text);
        if (initializer) {
          collectExportedObjectAuthorityReferences(
            initializer,
            forbiddenReferences,
            topLevelInitializers,
            new Set(visited).add(expression.text),
          );
        }
      }
    }
    return;
  }
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      collectExportedObjectAuthorityReferences(
        property.expression,
        forbiddenReferences,
        topLevelInitializers,
        visited,
      );
      continue;
    }
    const propertyName = property.name;
    if (
      propertyName &&
      (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)) &&
      FORBIDDEN_EXPORTS.has(propertyName.text)
    ) {
      forbiddenReferences.add(propertyName.text);
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (FORBIDDEN_EXPORTS.has(property.name.text)) {
        forbiddenReferences.add(property.name.text);
      }
    } else if (ts.isPropertyAssignment(property)) {
      collectExportedObjectAuthorityReferences(
        property.initializer,
        forbiddenReferences,
        topLevelInitializers,
        visited,
      );
    }
  }
}

function parseAuthorityExports(file, source) {
  const directNames = new Set();
  const forbiddenReferences = new Set();
  const starSpecifiers = [];
  const namedReexports = [];
  const namespaceReexports = [];
  const importBindings = [];
  const localExports = [];
  const expressionExports = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const authorityMarkers = new Set();
  const forbiddenTestFactoryMarkers = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      if (AUTHORITY_KERNEL_MARKERS.has(node.text)) {
        authorityMarkers.add(node.text);
      }
      if (FORBIDDEN_TEST_FACTORY_MARKERS.has(node.text)) {
        forbiddenTestFactoryMarkers.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const topLevelInitializers = new Map();
  const topLevelBindingOrigins = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        topLevelInitializers.set(declaration.name.text, declaration.initializer);
      }
      if (declaration.initializer) {
        collectBindingOrigins(
          declaration.name,
          declaration.initializer,
          [],
          [],
          topLevelBindingOrigins,
        );
      }
    }
  }
  const recordName = (name, exported = true) => {
    if (exported) {
      directNames.add(name);
    }
    if (FORBIDDEN_EXPORTS.has(name)) {
      forbiddenReferences.add(name);
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        importBindings.push({
          specifier,
          imported: "default",
          local: statement.importClause.name.text,
          namespace: false,
        });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        importBindings.push({
          specifier,
          imported: "*",
          local: bindings.name.text,
          namespace: true,
        });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importBindings.push({
            specifier,
            imported: element.propertyName?.text ?? element.name.text,
            local: element.name.text,
            namespace: false,
          });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      directNames.add("default");
      expressionExports.push({ expression: statement.expression, exported: "default" });
      if (ts.isIdentifier(statement.expression)) {
        recordName(statement.expression.text, false);
        const initializer = topLevelInitializers.get(statement.expression.text);
        if (initializer) {
          collectExportedObjectAuthorityReferences(
            initializer,
            forbiddenReferences,
            topLevelInitializers,
          );
        }
      }
      collectExportedObjectAuthorityReferences(
        statement.expression,
        forbiddenReferences,
        topLevelInitializers,
      );
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          starSpecifiers.push(statement.moduleSpecifier.text);
        }
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        recordName(statement.exportClause.name.text);
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          namespaceReexports.push({
            specifier: statement.moduleSpecifier.text,
            exported: statement.exportClause.name.text,
          });
        }
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        if (element.propertyName) {
          recordName(element.propertyName.text, false);
        }
        recordName(element.name.text);
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          namedReexports.push({
            specifier: statement.moduleSpecifier.text,
            imported: localName,
            exported: element.name.text,
          });
        } else {
          localExports.push({ local: localName, exported: element.name.text });
          const initializer = topLevelInitializers.get(localName);
          if (initializer) {
            collectExportedObjectAuthorityReferences(
              initializer,
              forbiddenReferences,
              topLevelInitializers,
              new Set([localName]),
            );
          }
        }
      }
      continue;
    }
    if (!hasExportModifier(statement)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (hasDefaultModifier(statement)) {
        directNames.add("default");
        if (statement.name) {
          recordName(statement.name.text, false);
        }
      } else if (statement.name) {
        recordName(statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const bindingNames = new Set();
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, bindingNames);
        if (declaration.initializer) {
          collectExportedObjectAuthorityReferences(
            declaration.initializer,
            forbiddenReferences,
            topLevelInitializers,
          );
        }
      }
      for (const name of bindingNames) {
        recordName(name);
        localExports.push({ local: name, exported: name });
      }
    }
  }
  return {
    directNames,
    forbiddenReferences,
    starSpecifiers,
    namedReexports,
    namespaceReexports,
    authorityMarkers,
    forbiddenTestFactoryMarkers,
    importBindings,
    localExports,
    expressionExports,
    topLevelInitializers,
    topLevelBindingOrigins,
    parseDiagnostics: sourceFile.parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    ),
  };
}

function resolveStarExport(fromFile, specifier, fileSet) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const candidate of [joined, `${joined}.js`, `${joined}/index.js`]) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function collectAuthorityExportErrors(files, readText) {
  const jsFiles = files
    .map((file) => file.replace(/\\/gu, "/"))
    .filter((file) => /^dist\/.*\.js$/u.test(file));
  const fileSet = new Set(jsFiles);
  const parsed = new Map(jsFiles.map((file) => [file, parseAuthorityExports(file, readText(file))]));
  const exportNames = new Map(
    [...parsed].map(([file, info]) => [file, new Set(info.directNames)]),
  );
  const authorityExportNames = new Map(
    [...parsed].map(([file, info]) => [
      file,
      info.authorityMarkers.size > 0 ? new Set(info.directNames) : new Set(),
    ]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, info] of parsed) {
      const names = exportNames.get(file);
      for (const specifier of info.starSpecifiers) {
        const target = resolveStarExport(file, specifier, fileSet);
        if (!target) {
          continue;
        }
        for (const name of exportNames.get(target) ?? []) {
          if (name !== "default" && !names.has(name)) {
            names.add(name);
            changed = true;
          }
        }
        for (const name of authorityExportNames.get(target) ?? []) {
          if (name !== "default" && !authorityExportNames.get(file).has(name)) {
            authorityExportNames.get(file).add(name);
            changed = true;
          }
        }
      }
      for (const edge of info.namedReexports) {
        const target = resolveStarExport(file, edge.specifier, fileSet);
        if (
          target &&
          authorityExportNames.get(target)?.has(edge.imported) &&
          !authorityExportNames.get(file).has(edge.exported)
        ) {
          authorityExportNames.get(file).add(edge.exported);
          changed = true;
        }
      }
      for (const edge of info.namespaceReexports) {
        const target = resolveStarExport(file, edge.specifier, fileSet);
        if (
          target &&
          (authorityExportNames.get(target)?.size ?? 0) > 0 &&
          !authorityExportNames.get(file).has(edge.exported)
        ) {
          authorityExportNames.get(file).add(edge.exported);
          changed = true;
        }
      }
      if (info.authorityMarkers.size > 0) {
        for (const name of names) {
          if (!authorityExportNames.get(file).has(name)) {
            authorityExportNames.get(file).add(name);
            changed = true;
          }
        }
      }
    }
    changed =
      propagateLocalAuthorityAliases({ parsed, fileSet, authorityExportNames }) || changed;
  }

  const errors = [];
  if (
    jsFiles.some((file) => /(?:^|\/)governor-host-bootstrap(?:-[^/]+)?\.js$/u.test(file)) &&
    ![...parsed.values()].some((info) => info.authorityMarkers.size > 0)
  ) {
    errors.push("governor host bootstrap dist inventory contains no durable authority marker");
  }
  for (const file of jsFiles) {
    const info = parsed.get(file);
    for (const diagnostic of info?.parseDiagnostics ?? []) {
      errors.push(`unparseable dist JavaScript in ${file}: ${diagnostic}`);
    }
    for (const name of info?.forbiddenTestFactoryMarkers ?? []) {
      errors.push(`forbidden shipped governor test-only marker ${name} in ${file}`);
    }
    const forbiddenNames = new Set(info?.forbiddenReferences ?? []);
    for (const name of exportNames.get(file) ?? []) {
      if (FORBIDDEN_EXPORTS.has(name)) {
        forbiddenNames.add(name);
      }
    }
    for (const name of forbiddenNames) {
      errors.push(`forbidden governor authority export ${name} in ${file}`);
    }
    for (const name of authorityExportNames.get(file) ?? []) {
      if (!ALLOWED_AUTHORITY_BEARING_EXPORTS.has(name)) {
        errors.push(`unexpected governor authority-bearing export ${name} in ${file}`);
      }
    }
  }
  return errors;
}

export function collectGovernorProductionAuthoritySurfaceErrors(files, readText) {
  const errors = collectGovernorTarEntryErrors(files);
  errors.push(...collectAuthorityExportErrors(files, readText));
  return errors;
}
