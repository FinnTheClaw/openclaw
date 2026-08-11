import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  root,
  "src/security/governor-host-delivery-build-manifest.generated.ts",
);
const entrypoints = [
  "src/security/governor-host-canary-sink.ts",
  "src/security/governor-host-channel-delivery.ts",
  "src/security/governor-host-delivery-broker.ts",
  "src/security/governor-host-delivery-implementations.ts",
  "src/security/governor-host-delivery-persistence.ts",
  "src/tasks/governor/delivery-certification-store.ts",
  "src/tasks/governor/delivery-dispatch.ts",
  "src/tasks/governor/outbox-store.ts",
  "extensions/imessage/index.ts",
  "extensions/imessage/setup-entry.ts",
  "extensions/signal/index.ts",
  "extensions/signal/setup-entry.ts",
];
const dynamicRoots = ["extensions/imessage/src", "extensions/signal/src"];
const dependencyArtifacts = [
  "package.json",
  "pnpm-lock.yaml",
  "extensions/imessage/openclaw.plugin.json",
  "extensions/imessage/package.json",
  "extensions/signal/npm-shrinkwrap.json",
  "extensions/signal/openclaw.plugin.json",
  "extensions/signal/package.json",
];
const selfFiles = new Set([
  "src/security/governor-host-delivery-build-manifest.generated.ts",
  "src/security/governor-host-delivery-build-manifest.ts",
]);

function isRuntimeSource(file) {
  return (
    /\.(?:[cm]?[jt]sx?|json|yaml)$/u.test(file) &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".d.ts") &&
    !selfFiles.has(file) &&
    !file.includes("/test-support/") &&
    !file.includes("/tests/")
  );
}

function listFiles(relativeDirectory) {
  const absolute = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Delivery manifest refuses symlinked runtime content: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(relative));
    } else if (entry.isFile() && isRuntimeSource(relative)) {
      files.push(relative);
    }
  }
  return files;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

function canonicalSource(relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Delivery manifest source escapes repository root: ${relativePath}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(absolute) !== absolute) {
    throw new Error(`Delivery manifest source must be a real repository file: ${relativePath}`);
  }
  return fs.readFileSync(absolute, "utf8").replaceAll("\r\n", "\n");
}

function runtimeModuleSpecifiers(relativePath) {
  if (!/\.[cm]?[jt]sx?$/u.test(relativePath)) {
    return [];
  }
  const source = canonicalSource(relativePath);
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveRelativeImport(importer, specifier) {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
    throw new Error(
      `Delivery manifest import escapes repository root: ${importer} -> ${specifier}`,
    );
  }
  const extension = path.posix.extname(unresolved);
  const candidates = extension
    ? extension === ".js"
      ? [unresolved.slice(0, -3) + ".ts", unresolved.slice(0, -3) + ".tsx", unresolved]
      : [unresolved]
    : [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.js`,
        `${unresolved}.mjs`,
        `${unresolved}.json`,
        `${unresolved}/index.ts`,
        `${unresolved}/index.tsx`,
        `${unresolved}/index.js`,
      ];
  const resolved = candidates.filter(
    (candidate) =>
      fs.existsSync(path.join(root, candidate)) &&
      (selfFiles.has(candidate) || isRuntimeSource(candidate)),
  );
  if (resolved.length !== 1) {
    throw new Error(`Delivery manifest import is unresolved: ${importer} -> ${specifier}`);
  }
  return resolved[0];
}

function resolvePluginSdkImport(importer, specifier) {
  const prefix = "openclaw/plugin-sdk";
  if (specifier !== prefix && !specifier.startsWith(`${prefix}/`)) {
    return null;
  }
  const subpath = specifier === prefix ? "index" : specifier.slice(prefix.length + 1);
  if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(subpath) || subpath.includes("..")) {
    throw new Error(`Delivery manifest plugin SDK import is invalid: ${importer} -> ${specifier}`);
  }
  const unresolved = `src/plugin-sdk/${subpath}`;
  const candidates = [`${unresolved}.ts`, `${unresolved}.tsx`, `${unresolved}/index.ts`].filter(
    (candidate) => fs.existsSync(path.join(root, candidate)) && isRuntimeSource(candidate),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Delivery manifest plugin SDK import is unresolved: ${importer} -> ${specifier}`,
    );
  }
  return candidates[0];
}

function collectRuntimeClosure() {
  const queued = [...entrypoints, ...dynamicRoots.flatMap(listFiles), ...dependencyArtifacts];
  const visited = new Set();
  while (queued.length > 0) {
    const relativePath = queued.pop();
    if (!relativePath || visited.has(relativePath) || selfFiles.has(relativePath)) {
      continue;
    }
    if (!fs.existsSync(path.join(root, relativePath)) || !isRuntimeSource(relativePath)) {
      throw new Error(`Delivery manifest source is missing or unsupported: ${relativePath}`);
    }
    visited.add(relativePath);
    for (const specifier of runtimeModuleSpecifiers(relativePath)) {
      if (specifier.startsWith(".")) {
        queued.push(resolveRelativeImport(relativePath, specifier));
        continue;
      }
      const pluginSdk = resolvePluginSdkImport(relativePath, specifier);
      if (pluginSdk) {
        queued.push(pluginSdk);
      }
    }
  }
  return [...visited].toSorted((left, right) => left.localeCompare(right));
}

const paths = collectRuntimeClosure();
const artifacts = paths.map((relativePath) => ({
  path: relativePath,
  sha256: sha256(canonicalSource(relativePath)),
}));
const manifest = { version: 3, entrypoints, dynamicRoots, artifacts };
const manifestPayload = JSON.stringify(normalizeJson(manifest));
const manifestDigest = sha256(manifestPayload);
const artifactSource = artifacts
  .map(
    (artifact) =>
      `    {\n      path: ${JSON.stringify(artifact.path)},\n` +
      `      sha256: ${JSON.stringify(artifact.sha256)},\n    },`,
  )
  .join("\n");
const arraySource = (values) => values.map((value) => `    ${JSON.stringify(value)},`).join("\n");
const generated =
  `// Generated by scripts/generate-governor-delivery-manifest.mjs. Do not edit.\n` +
  `export const GOVERNOR_DELIVERY_BUILD_MANIFEST = {\n` +
  `  version: 3,\n` +
  `  entrypoints: [\n${arraySource(entrypoints)}\n  ],\n` +
  `  dynamicRoots: [${dynamicRoots.map((value) => JSON.stringify(value)).join(", ")}],\n` +
  `  artifacts: [\n${artifactSource}\n  ],\n} as const;\n` +
  `export const GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST =\n` +
  `  ${JSON.stringify(manifestDigest)};\n`;

if (process.argv.includes("--verify")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error("Governor delivery build manifest is stale. Run pnpm governor:manifest:gen.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(outputPath, generated);
}
