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
];
const dynamicRoots = ["extensions/imessage/src", "extensions/signal/src"];
const dependencyArtifacts = ["package.json", "pnpm-lock.yaml"];
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
  return fs.readFileSync(path.join(root, relativePath), "utf8").replaceAll("\r\n", "\n");
}

function relativeModuleSpecifiers(relativePath) {
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
  return specifiers.filter((specifier) => specifier.startsWith("."));
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
  const resolved = candidates.find(
    (candidate) =>
      fs.existsSync(path.join(root, candidate)) &&
      (selfFiles.has(candidate) || isRuntimeSource(candidate)),
  );
  if (!resolved) {
    throw new Error(`Delivery manifest import is unresolved: ${importer} -> ${specifier}`);
  }
  return resolved;
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
    for (const specifier of relativeModuleSpecifiers(relativePath)) {
      queued.push(resolveRelativeImport(relativePath, specifier));
    }
  }
  return [...visited].toSorted((left, right) => left.localeCompare(right));
}

const paths = collectRuntimeClosure();
const artifacts = paths.map((relativePath) => ({
  path: relativePath,
  sha256: sha256(canonicalSource(relativePath)),
}));
const manifest = { version: 2, entrypoints, dynamicRoots, artifacts };
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
  `  version: 2,\n` +
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
