import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOwnerBoundaries } from "../../scripts/check-hardening-authority.mjs";
import {
  assertAppendOnly,
  assertCandidateHistory,
  assertEntryObject,
  assertRegistryHistory,
  assertSupersessionObjects,
  renderHuman,
  validateRegistry,
} from "../../scripts/check-hardening-dni.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function patch(repo: string, sha: string): Buffer {
  return execFileSync(
    "git",
    ["show", "--no-ext-diff", "--no-renames", "--format=", "--binary", sha],
    { cwd: repo },
  );
}

function patchId(repo: string, sha: string): string {
  return execFileSync("git", ["patch-id", "--stable"], {
    cwd: repo,
    input: patch(repo, sha),
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/u)[0]!;
}

function registry(base: string, upstreamCommit: string) {
  const entry = {
    id: "DNI-test-U00001",
    upstreamId: "U00001",
    upstreamCommit,
    stablePatchId: patchId(currentRoot!, upstreamCommit),
    patchSha256: createHash("sha256").update(patch(currentRoot!, upstreamCommit)).digest("hex"),
    reason: "A second durable authority is forbidden.",
    duplicatedAuthority: { domain: "test-authority", ownerBoundary: "task-authority-owner" },
    allowedSemanticReuse: "Use an independently implemented parity test only.",
    evidence: { source: "test-report", anchor: "U00001" },
  };
  return validateRegistry({
    schemaVersion: 2,
    candidateHistoryBase: base,
    evidenceSources: {
      "test-report": {
        reportId: "TEST_REPORT",
        locator: "openclaw-hardening:audit/TEST_REPORT",
        sha256: "a".repeat(64),
      },
    },
    entries: [entry],
    supersessions: [],
  });
}

let currentRoot: string | undefined;

function makeRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "hardening-dni-"));
  temporaryRoots.push(root);
  git(root, ["init"]);
  writeFileSync(path.join(root, "state.txt"), "base\n");
  const base = commit(root, "base");
  writeFileSync(path.join(root, "state.txt"), "forbidden\n");
  const upstream = commit(root, "forbidden upstream patch");
  currentRoot = root;
  return { root, base, upstream };
}

describe("hardening DNI registry", () => {
  it("rejects an exact upstream commit and a patch-id-equivalent replay", () => {
    const { root, base, upstream } = makeRepository();
    const active = registry(base, upstream);
    expect(() => assertCandidateHistory(root, active)).toThrow(/direct upstream SHA/u);
    git(root, ["reset", "--hard", base]);
    writeFileSync(path.join(root, "state.txt"), "forbidden\n");
    const replay = commit(root, "same patch, distinct commit");
    expect(replay).not.toBe(upstream);
    expect(() => assertCandidateHistory(root, active)).toThrow(/stable patch-id equivalent/u);
  });

  it("verifies stable patch and content hashes against an available upstream object", () => {
    const { root, base, upstream } = makeRepository();
    const active = registry(base, upstream);
    expect(assertEntryObject(root, active.entries[0]!)).toEqual({ verified: "git-object" });
    active.entries[0]!.patchSha256 = "b".repeat(64);
    expect(() => assertEntryObject(root, active.entries[0]!)).toThrow(/patchSha256/u);
  });

  it("permits only appended reviewed supersession records", () => {
    const { root, base, upstream } = makeRepository();
    const prior = registry(base, upstream);
    git(root, ["reset", "--hard", base]);
    writeFileSync(path.join(root, "reviewed.txt"), "reviewed\n");
    const reviewed = commit(root, "reviewed replacement");
    const current = structuredClone(prior);
    current.supersessions.push({
      dniId: prior.entries[0]!.id,
      reviewedCommit: reviewed,
      reason: "Reviewed replacement preserves the sole owner.",
      evidence: { source: "test-report", anchor: "review" },
    });
    const accepted = validateRegistry(current);
    expect(() => assertAppendOnly(accepted, prior)).not.toThrow();
    expect(() => assertSupersessionObjects(root, accepted)).not.toThrow();
    const duplicate = structuredClone(accepted);
    duplicate.supersessions.push(structuredClone(duplicate.supersessions[0]!));
    expect(() => validateRegistry(duplicate)).toThrow(/supersessions duplicate/u);
    const unknown = structuredClone(accepted);
    unknown.supersessions[0]!.reviewedCommit = "b".repeat(40);
    expect(() => assertSupersessionObjects(root, validateRegistry(unknown))).toThrow(
      /unavailable/u,
    );
    const mutated = structuredClone(prior);
    mutated.entries[0]!.reason = "rewritten";
    expect(() => assertAppendOnly(validateRegistry(mutated), prior)).toThrow(/immutable record/u);
  });

  it("rejects reordering or inserting before an immutable entry", () => {
    const { base, upstream } = makeRepository();
    const prior = registry(base, upstream);
    const reordered = structuredClone(prior);
    reordered.entries.unshift({ ...structuredClone(reordered.entries[0]!), id: "DNI-test-U00002" });
    expect(() => assertAppendOnly(reordered, prior)).toThrow(/ordered immutable record/u);
  });

  it("rejects a two-commit delete then restore bypass in complete history", () => {
    const { root, base, upstream } = makeRepository();
    git(root, ["reset", "--hard", base]);
    const active = registry(base, upstream);
    const relative = "governance/hardening-dni.json";
    mkdirSync(path.join(root, "governance"));
    writeFileSync(path.join(root, relative), JSON.stringify(active, null, 2));
    commit(root, "introduce registry");
    rmSync(path.join(root, relative));
    commit(root, "delete registry");
    writeFileSync(path.join(root, relative), JSON.stringify(active, null, 2));
    commit(root, "restore registry");
    expect(() => assertRegistryHistory(root, relative, active)).toThrow(
      /removed in historical commit/u,
    );
  });

  it("renders reason, clean-room reuse, and immutable evidence into the human mirror", () => {
    const { base, upstream } = makeRepository();
    const rendered = renderHuman(registry(base, upstream));
    expect(rendered).toContain("second durable authority");
    expect(rendered).toContain("independently implemented parity test");
    expect(rendered).toContain("TEST_REPORT#U00001");
  });

  it("requires every DNI owner boundary to exist in the durable owner inventory", () => {
    const { base, upstream } = makeRepository();
    const active = registry(base, upstream);
    expect(() => assertOwnerBoundaries(active, ["task-authority-owner"])).not.toThrow();
    expect(() => assertOwnerBoundaries(active, [])).toThrow(/unknown durable owner boundary/u);
  });

  it("fails closed when the upstream object is unavailable", () => {
    const { base, upstream, root } = makeRepository();
    const active = registry(base, upstream);
    active.entries[0]!.upstreamCommit = "c".repeat(40);
    expect(() => assertEntryObject(root, active.entries[0]!)).toThrow(/unavailable/u);
  });
});
