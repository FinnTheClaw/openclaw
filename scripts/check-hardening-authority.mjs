#!/usr/bin/env node
// Verifies that exclusion records name a boundary in the durable-owner inventory.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRegistry } from "./check-hardening-dni.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error("hardening authority: " + message);
}

export function assertOwnerBoundaries(registry, ownerIds) {
  const known = new Set(ownerIds);
  for (const entry of registry.entries) {
    const owner = entry.duplicatedAuthority.ownerBoundary;
    if (!known.has(owner)) fail(entry.id + " names unknown durable owner boundary " + owner);
  }
}

export function loadDurableOwnerIds(repo = root) {
  const source = [
    "import { GOVERNOR_DURABLE_BOUNDARIES } from './src/security/governor-durable-boundary-registry.ts';",
    "process.stdout.write(JSON.stringify(GOVERNOR_DURABLE_BOUNDARIES.map((entry) => entry.id)));",
  ].join(" ");
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  const ids = JSON.parse(output);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    fail("durable owner inventory is malformed");
  return ids;
}

export function main() {
  const registry = readRegistry();
  assertOwnerBoundaries(registry, loadDurableOwnerIds());
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
