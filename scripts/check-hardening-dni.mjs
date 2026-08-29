#!/usr/bin/env node
// Release-time, append-only exclusion control for reviewed direct-transplant rejections.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRegistryPath = path.join(root, "governance", "hardening-dni.json");
const defaultHumanPath = path.join(root, "governance", "hardening-dni.md");
const sha1 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const upstreamId = /^U[0-9]{5}$/u;

function fail(message) {
  throw new Error("hardening DNI: " + message);
}

function git(repo, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: repo, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function gitHas(repo, args) {
  try {
    execFileSync("git", args, { cwd: repo, stdio: "ignore", maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(field + " must be a non-empty string");
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).toSorted().join("\0");
  const wanted = [...expected].toSorted().join("\0");
  if (actual !== wanted) fail(label + " has unexpected or missing fields");
}

function digest(value, field, pattern) {
  const result = requireString(value, field);
  if (!pattern.test(result)) fail(field + " is not a lowercase digest");
  return result;
}

function validateEvidenceSources(value) {
  if (!isRecord(value) || Object.keys(value).length === 0)
    fail("evidenceSources must be non-empty");
  for (const [id, source] of Object.entries(value)) {
    if (!isRecord(source)) fail("evidenceSources." + id + " must be an object");
    exactKeys(source, ["locator", "reportId", "sha256"], "evidenceSources." + id);
    requireString(source.reportId, "evidenceSources." + id + ".reportId");
    requireString(source.locator, "evidenceSources." + id + ".locator");
    digest(source.sha256, "evidenceSources." + id + ".sha256", sha256);
  }
  return value;
}

function validateEvidence(value, sources, label) {
  if (!isRecord(value)) fail(label + ".evidence must be an object");
  exactKeys(value, ["anchor", "source"], label + ".evidence");
  const source = requireString(value.source, label + ".evidence.source");
  if (!Object.hasOwn(sources, source))
    fail(label + ".evidence.source is not an immutable evidence source");
  requireString(value.anchor, label + ".evidence.anchor");
}

function validateSupersession(value, ids, sources, index) {
  const label = "supersessions[" + index + "]";
  if (!isRecord(value)) fail(label + " must be an object");
  exactKeys(value, ["dniId", "evidence", "reason", "reviewedCommit"], label);
  const dniId = requireString(value.dniId, label + ".dniId");
  if (!ids.has(dniId)) fail(label + ".dniId does not name an immutable rejection");
  digest(value.reviewedCommit, label + ".reviewedCommit", sha1);
  requireString(value.reason, label + ".reason");
  validateEvidence(value.evidence, sources, label);
}

export function validateRegistry(value) {
  if (!isRecord(value)) fail("registry must be an object");
  exactKeys(
    value,
    ["candidateHistoryBase", "entries", "evidenceSources", "schemaVersion", "supersessions"],
    "registry",
  );
  if (value.schemaVersion !== 2) fail("registry schemaVersion must be 2");
  digest(value.candidateHistoryBase, "candidateHistoryBase", sha1);
  const sources = validateEvidenceSources(value.evidenceSources);
  if (!Array.isArray(value.entries) || value.entries.length === 0)
    fail("entries must be non-empty");
  if (!Array.isArray(value.supersessions)) fail("supersessions must be an array");
  const ids = new Set();
  const commits = new Set();
  const patchIds = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const label = "entries[" + index + "]";
    if (!isRecord(entry)) fail(label + " must be an object");
    exactKeys(
      entry,
      [
        "allowedSemanticReuse",
        "duplicatedAuthority",
        "evidence",
        "id",
        "patchSha256",
        "reason",
        "stablePatchId",
        "upstreamCommit",
        "upstreamId",
      ],
      label,
    );
    const id = requireString(entry.id, label + ".id");
    const commit = digest(entry.upstreamCommit, label + ".upstreamCommit", sha1);
    const patchId = digest(entry.stablePatchId, label + ".stablePatchId", sha1);
    if (ids.has(id) || commits.has(commit) || patchIds.has(patchId))
      fail(label + " duplicates an id, commit, or patch-id");
    ids.add(id);
    commits.add(commit);
    patchIds.add(patchId);
    if (!upstreamId.test(requireString(entry.upstreamId, label + ".upstreamId")))
      fail(label + ".upstreamId is invalid");
    digest(entry.patchSha256, label + ".patchSha256", sha256);
    if (!isRecord(entry.duplicatedAuthority))
      fail(label + ".duplicatedAuthority must be an object");
    exactKeys(
      entry.duplicatedAuthority,
      ["domain", "ownerBoundary"],
      label + ".duplicatedAuthority",
    );
    requireString(entry.duplicatedAuthority.domain, label + ".duplicatedAuthority.domain");
    requireString(
      entry.duplicatedAuthority.ownerBoundary,
      label + ".duplicatedAuthority.ownerBoundary",
    );
    requireString(entry.reason, label + ".reason");
    requireString(entry.allowedSemanticReuse, label + ".allowedSemanticReuse");
    validateEvidence(entry.evidence, sources, label);
  }
  const supersededIds = new Set();
  for (const [index, supersession] of value.supersessions.entries()) {
    validateSupersession(supersession, ids, sources, index);
    if (supersededIds.has(supersession.dniId))
      fail("supersessions duplicate " + supersession.dniId);
    supersededIds.add(supersession.dniId);
  }
  return value;
}

export function readRegistry(registryPath = defaultRegistryPath) {
  return validateRegistry(JSON.parse(readFileSync(registryPath, "utf8")));
}

function stablePatchId(repo, commit) {
  const patch = git(
    repo,
    ["show", "--no-ext-diff", "--no-renames", "--format=", "--binary", commit],
    "buffer",
  );
  if (patch.length === 0) return null;
  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd: repo,
    input: patch,
    encoding: "utf8",
  });
  if (result.status !== 0) fail("cannot calculate stable patch-id for " + commit);
  const patchId = result.stdout.trim().split(/\s+/u)[0];
  if (!sha1.test(patchId ?? "")) fail("stable patch-id output is malformed for " + commit);
  return patchId;
}

export function assertEntryObject(repo, entry) {
  if (!gitHas(repo, ["cat-file", "-e", entry.upstreamCommit + "^{commit}"])) {
    fail(entry.id + " upstream commit object is unavailable");
  }
  const patch = git(
    repo,
    ["show", "--no-ext-diff", "--no-renames", "--format=", "--binary", entry.upstreamCommit],
    "buffer",
  );
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  if (patchSha256 !== entry.patchSha256)
    fail(entry.id + " patchSha256 does not match its upstream commit");
  const actualPatchId = stablePatchId(repo, entry.upstreamCommit);
  if (actualPatchId !== entry.stablePatchId)
    fail(entry.id + " stablePatchId does not match its upstream commit");
  return { verified: "git-object" };
}

export function assertEntryObjects(repo, registry) {
  for (const entry of registry.entries) assertEntryObject(repo, entry);
}

export function assertAppendOnly(current, previous) {
  if (!previous) return;
  if (current.entries.length < previous.entries.length)
    fail("append-only registry removed an immutable record");
  for (const [index, before] of previous.entries.entries()) {
    if (JSON.stringify(before) !== JSON.stringify(current.entries[index])) {
      fail("append-only registry changed ordered immutable record " + before.id);
    }
  }
  for (const [sourceId, before] of Object.entries(previous.evidenceSources)) {
    if (JSON.stringify(before) !== JSON.stringify(current.evidenceSources[sourceId]))
      fail("append-only registry changed immutable evidence source " + sourceId);
  }
  const beforeSupersessions = previous.supersessions.map((item) => JSON.stringify(item));
  const nowSupersessions = current.supersessions.map((item) => JSON.stringify(item));
  if (nowSupersessions.length < beforeSupersessions.length)
    fail("append-only registry removed a supersession");
  for (const [index, item] of beforeSupersessions.entries()) {
    if (nowSupersessions[index] !== item)
      fail("append-only registry rewrote supersession " + index);
  }
}

export function assertSupersessionObjects(repo, registry) {
  const ids = new Set();
  for (const supersession of registry.supersessions) {
    if (ids.has(supersession.dniId)) fail("multiple supersessions target " + supersession.dniId);
    ids.add(supersession.dniId);
    if (!gitHas(repo, ["cat-file", "-e", supersession.reviewedCommit + "^{commit}"])) {
      fail("supersession reviewed commit is unavailable for " + supersession.dniId);
    }
    if (!gitHas(repo, ["merge-base", "--is-ancestor", supersession.reviewedCommit, "HEAD"])) {
      fail("supersession reviewed commit is not an ancestor of HEAD for " + supersession.dniId);
    }
  }
}

export function assertRegistryHistory(
  repo,
  registryRelativePath,
  current,
  base = current.candidateHistoryBase,
) {
  if (!gitHas(repo, ["merge-base", "--is-ancestor", base, "HEAD"]))
    fail("candidate base is not an ancestor of HEAD: " + base);
  const commits = git(repo, ["rev-list", "--topo-order", "--reverse", base + "..HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean);
  let previous = null;
  let introduced = false;
  for (const commit of commits) {
    const spec = commit + ":" + registryRelativePath;
    if (!gitHas(repo, ["cat-file", "-e", spec])) {
      if (introduced) fail("append-only registry was removed in historical commit " + commit);
      continue;
    }
    introduced = true;
    const historical = validateRegistry(JSON.parse(git(repo, ["show", spec])));
    assertAppendOnly(historical, previous);
    previous = historical;
  }
  assertAppendOnly(current, previous);
  return previous;
}

function supersededIds(registry) {
  return new Set(registry.supersessions.map((item) => item.dniId));
}

export function assertCandidateHistory(repo, registry, base = registry.candidateHistoryBase) {
  if (!gitHas(repo, ["merge-base", "--is-ancestor", base, "HEAD"]))
    fail("candidate base is not an ancestor of HEAD: " + base);
  const superseded = supersededIds(registry);
  const active = registry.entries.filter((entry) => !superseded.has(entry.id));
  const byCommit = new Map(active.map((entry) => [entry.upstreamCommit, entry]));
  const byPatch = new Map(active.map((entry) => [entry.stablePatchId, entry]));
  const commits = git(repo, ["rev-list", "--topo-order", "--reverse", base + "..HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean);
  const violations = [];
  for (const commit of commits) {
    const direct = byCommit.get(commit);
    if (direct) {
      violations.push(direct.id + " (" + direct.upstreamId + "): direct upstream SHA " + commit);
      continue;
    }
    const patchId = stablePatchId(repo, commit);
    const equivalent = patchId ? byPatch.get(patchId) : undefined;
    if (equivalent)
      violations.push(
        equivalent.id + " (" + equivalent.upstreamId + "): stable patch-id equivalent " + commit,
      );
  }
  if (violations.length > 0)
    fail("rejected direct-transplant history detected:\n" + violations.join("\n"));
}

export function renderHuman(registry) {
  const evidenceFor = (entry) => {
    const evidence = registry.evidenceSources[entry.evidence.source];
    return evidence.reportId + "#" + entry.evidence.anchor + " (`" + evidence.sha256 + "`)";
  };
  const states = supersededIds(registry);
  const rows = registry.entries.map((entry) => {
    const owner =
      entry.duplicatedAuthority.domain + " / " + entry.duplicatedAuthority.ownerBoundary;
    const state = states.has(entry.id) ? "superseded" : "active";
    return (
      "| " +
      entry.id +
      " | " +
      state +
      " | " +
      entry.upstreamId +
      " | " +
      entry.upstreamCommit +
      " | " +
      entry.stablePatchId +
      " | " +
      owner +
      " | " +
      entry.reason +
      " | " +
      entry.allowedSemanticReuse +
      " | " +
      evidenceFor(entry) +
      " |"
    );
  });
  return [
    "# Hardening DNI registry",
    "",
    "Generated from `governance/hardening-dni.json`; do not edit this mirror directly.",
    "",
    "DNI entries reject the exact upstream SHA and any stable patch-id-equivalent direct transplant. Original rejection records and evidence bindings are append-only. A future reconsideration appends a reviewed supersession; it never edits or deletes the rejection.",
    "",
    "| DNI ID | State | Upstream ID | Upstream SHA | Stable patch-id | Existing sole authority | Reason | Allowed clean-room semantic/test reuse | Immutable evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    base: null,
    registryPath: defaultRegistryPath,
    verifyHuman: false,
    writeHuman: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base" || argument === "--registry") {
      const value = argv[++index];
      if (!value) fail(argument + " requires a value");
      if (argument === "--base") result.base = value;
      else result.registryPath = path.resolve(value);
    } else if (argument === "--verify-human") result.verifyHuman = true;
    else if (argument === "--write-human") result.writeHuman = true;
    else fail("unknown argument " + argument);
  }
  if (result.verifyHuman && result.writeHuman)
    fail("--verify-human and --write-human are mutually exclusive");
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const registry = readRegistry(args.registryPath);
  const relative = path.relative(root, args.registryPath).replaceAll(path.sep, "/");
  if (relative.startsWith("../") || path.isAbsolute(relative))
    fail("registry must remain inside the repository");
  assertRegistryHistory(root, relative, registry, args.base ?? registry.candidateHistoryBase);
  assertEntryObjects(root, registry);
  assertSupersessionObjects(root, registry);
  const human = renderHuman(registry);
  if (args.writeHuman) writeFileSync(defaultHumanPath, human, "utf8");
  if (args.verifyHuman && readFileSync(defaultHumanPath, "utf8") !== human)
    fail("human DNI mirror is stale; run node scripts/check-hardening-dni.mjs --write-human");
  assertCandidateHistory(root, registry, args.base ?? registry.candidateHistoryBase);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
