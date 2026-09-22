// Scans packaged dist JavaScript for relative imports and missing closure entries.
import { createRequire } from "node:module";
import path from "node:path";
import { visitModuleSpecifiers } from "./guard-inventory-utils.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const JS_DIST_FILE_RE = /^dist\/.*\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasJavaScriptFileExtension(value) {
  return /\.(?:cjs|js|mjs)$/u.test(path.posix.basename(stripSpecifierSuffix(value)));
}

function resolveCommonJsPath(candidatePath, fileSet, readText, seen = new Set()) {
  if (seen.has(candidatePath)) {
    return null;
  }
  seen.add(candidatePath);
  for (const extension of ["", ".js", ".json", ".node"]) {
    const filePath = `${candidatePath}${extension}`;
    if (fileSet.has(filePath)) {
      return filePath;
    }
  }

  const packageJsonPath = `${candidatePath}/package.json`;
  if (fileSet.has(packageJsonPath)) {
    try {
      const packageMain = JSON.parse(readText(packageJsonPath)).main;
      if (typeof packageMain === "string" && packageMain) {
        const resolvedMain = resolveCommonJsPath(
          path.posix.normalize(path.posix.join(candidatePath, packageMain)),
          fileSet,
          readText,
          seen,
        );
        if (resolvedMain) {
          return resolvedMain;
        }
      }
    } catch {
      // Node falls back to index resolution when package metadata is unusable.
    }
  }
  for (const extension of [".js", ".json", ".node"]) {
    const indexPath = `${candidatePath}/index${extension}`;
    if (fileSet.has(indexPath)) {
      return indexPath;
    }
  }
  return null;
}

function resolveDistImportPath(importerPath, specifier, kind, fileSet, readText) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolvedPath = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(importerPath),
      kind === "commonjs-require" ? specifier : stripSpecifierSuffix(specifier),
    ),
  );
  if (!resolvedPath) {
    return null;
  }
  if (kind !== "commonjs-require") {
    return resolvedPath;
  }
  return resolveCommonJsPath(resolvedPath, fileSet, readText) ?? resolvedPath;
}

function collectImportSpecifiers(source, importerPath) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    importerPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  visitModuleSpecifiers(
    ts,
    sourceFile,
    ({ kind, specifier }) => {
      if (
        specifier.startsWith(".") &&
        (kind !== "import-meta-url" ||
          (hasJavaScriptFileExtension(specifier) &&
            resolveDistImportPath(importerPath, specifier)?.startsWith("dist/")))
      ) {
        specifiers.push({ kind, specifier });
      }
    },
    { includeCommonJs: true, includeImportMetaUrl: true },
  );
  return specifiers;
}

/** Collect missing-file errors for relative imports inside package dist files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });

  for (const { importerPath, importedPath } of imports) {
    if (!fileSet.has(importedPath)) {
      errors.push(`${importerPath} imports missing ${importedPath}`);
    }
  }

  return errors;
}

/** Collect relative dist import edges from package JavaScript files. */
function collectPackageDistImports(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const imports = [];
  const fileSet = new Set(files);

  for (const importerPath of files.toSorted((left, right) => left.localeCompare(right))) {
    if (!JS_DIST_FILE_RE.test(importerPath) || importerPath.includes("/node_modules/")) {
      continue;
    }
    const source = params.readText(importerPath);
    for (const { kind, specifier } of collectImportSpecifiers(source, importerPath)) {
      const importedPath = resolveDistImportPath(
        importerPath,
        specifier,
        kind,
        fileSet,
        params.readText,
      );
      if (!importedPath) {
        continue;
      }
      imports.push({ importerPath, importedPath });
    }
  }

  return imports;
}
