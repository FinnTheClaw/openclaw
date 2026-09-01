import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Every module that can alter an npm-shrinkwrap output or the npm command that
// produces it. A change to one of these paths plus a shrinkwrap must use the
// prior shrinkwrap revision as provenance, never the candidate itself.
export const SHRINKWRAP_OUTPUT_LOGIC_PATHS = new Set([
  "scripts/generate-npm-shrinkwrap.mjs",
  "scripts/npm-runner.mjs",
  "scripts/npm-shrinkwrap-provenance.mjs",
  "scripts/windows-cmd-helpers.mjs",
]);

export function changesShrinkwrapOutputLogic(changedPaths) {
  return changedPaths.some((changedPath) => SHRINKWRAP_OUTPUT_LOGIC_PATHS.has(changedPath));
}

export function canonicalizeResolutionInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeResolutionInput(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeResolutionInput(entry)]),
  );
}

function pnpmDependencyVersion(value) {
  if (typeof value === "string") {
    return value;
  }
  return typeof value?.version === "string" ? value.version : null;
}

export function pnpmResolutionTopology(lockfile, importerPath) {
  const importer = lockfile?.importers?.[importerPath];
  if (!importer || typeof importer !== "object") {
    return null;
  }
  const snapshots = lockfile.snapshots ?? {};
  const packages = lockfile.packages ?? {};
  const collectedSnapshots = {};
  const collectedPackages = {};
  const pending = [];
  const seen = new Set();
  const collectDependencies = (metadata) => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, value] of Object.entries(metadata?.[field] ?? {})) {
        const version = pnpmDependencyVersion(value);
        if (version && !version.startsWith("link:") && !version.startsWith("workspace:")) {
          pending.push([name, version]);
        }
      }
    }
  };
  collectDependencies(importer);

  while (pending.length > 0) {
    const [name, version] = pending.pop();
    const snapshotKey = snapshots[`${name}@${version}`] ? `${name}@${version}` : version;
    if (seen.has(snapshotKey)) {
      continue;
    }
    seen.add(snapshotKey);
    const snapshot = snapshots[snapshotKey];
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }
    collectedSnapshots[snapshotKey] = snapshot;
    const packageKey = snapshotKey.replace(/\(.+$/u, "");
    if (packages[packageKey]) {
      collectedPackages[packageKey] = packages[packageKey];
    }
    collectDependencies(snapshot);
  }

  return JSON.stringify(
    canonicalizeResolutionInput({
      importer,
      packages: collectedPackages,
      snapshots: collectedSnapshots,
    }),
  );
}

export function shrinkwrapLeaves(shrinkwrapText) {
  const packages = JSON.parse(shrinkwrapText)?.packages ?? {};
  return canonicalizeResolutionInput(
    Object.fromEntries(Object.entries(packages).filter(([lockPath]) => lockPath !== "")),
  );
}

export function provenanceShrinkwrapRevision(rootDir, relativeShrinkwrapPath) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const candidateRevision = git(["log", "-1", "--format=%H", "HEAD", "--", relativeShrinkwrapPath]);
  if (!/^[0-9a-f]{40}$/u.test(candidateRevision)) {
    return null;
  }
  const changedPaths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", candidateRevision]);
  if (!changesShrinkwrapOutputLogic(changedPaths.split("\n"))) {
    return candidateRevision;
  }
  const sourceRevision = git([
    "log",
    "-1",
    "--format=%H",
    `${candidateRevision}^`,
    "--",
    relativeShrinkwrapPath,
  ]);
  return /^[0-9a-f]{40}$/u.test(sourceRevision) ? sourceRevision : null;
}

export function shrinkwrapMatchesCurrentPnpmLockTopology({
  rootDir,
  packageDir,
  packageLabel,
  shrinkwrapPath,
}) {
  const relativeShrinkwrapPath = path.relative(rootDir, shrinkwrapPath).replaceAll(path.sep, "/");
  if (!relativeShrinkwrapPath || relativeShrinkwrapPath.startsWith("../")) {
    return false;
  }
  try {
    const revision = provenanceShrinkwrapRevision(rootDir, relativeShrinkwrapPath);
    if (!revision) {
      return false;
    }
    const gitShow = (pathAtRevision) =>
      execFileSync("git", ["show", `${revision}:${pathAtRevision}`], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "ignore"],
      });
    const priorTopology = pnpmResolutionTopology(
      parseYaml(gitShow("pnpm-lock.yaml").toString("utf8")),
      packageLabel,
    );
    const currentTopology = pnpmResolutionTopology(
      parseYaml(readFileSync(path.join(rootDir, "pnpm-lock.yaml"), "utf8")),
      packageLabel,
    );
    return (
      JSON.stringify(shrinkwrapLeaves(readFileSync(shrinkwrapPath, "utf8"))) ===
        JSON.stringify(shrinkwrapLeaves(gitShow(relativeShrinkwrapPath).toString("utf8"))) &&
      priorTopology !== null &&
      priorTopology === currentTopology
    );
  } catch {
    return false;
  }
}

function resolutionInputsForRoot(metadata) {
  return JSON.stringify(
    ["dependencies", "optionalDependencies", "overrides"].map((field) => [
      field,
      canonicalizeResolutionInput(metadata?.[field] ?? {}),
    ]),
  );
}

export function restoreCurrentPnpmLockedPackages({
  generated,
  current,
  pnpmLockPackages,
  preserveCurrentResolvedGraph = false,
  collectPnpmLockViolations,
  dependencySpecForLockPath,
  isStablePatchDrift,
  packageNameForLockPath,
  versionSatisfiesSimpleSpec,
}) {
  if (!current) return generated;
  const generatedPackages = generated?.packages;
  const currentPackages = current?.packages;
  if (
    !generatedPackages ||
    typeof generatedPackages !== "object" ||
    !currentPackages ||
    typeof currentPackages !== "object"
  ) {
    return generated;
  }
  if (
    preserveCurrentResolvedGraph &&
    resolutionInputsForRoot(generatedPackages[""]) ===
      resolutionInputsForRoot(currentPackages[""]) &&
    collectPnpmLockViolations({ packages: currentPackages }, pnpmLockPackages).length === 0
  ) {
    generated.packages = {
      "": generatedPackages[""],
      ...Object.fromEntries(
        Object.entries(currentPackages).filter(([lockPath]) => lockPath !== ""),
      ),
    };
    return generated;
  }
  for (const [lockPath, metadata] of Object.entries(generatedPackages)) {
    if (lockPath === "" || !metadata || typeof metadata !== "object" || !metadata.version) continue;
    const packageName = metadata.name ?? packageNameForLockPath(lockPath);
    if (!packageName || pnpmLockPackages.has(`${packageName}@${metadata.version}`)) continue;
    const currentMetadata = currentPackages[lockPath];
    const currentPackageName = currentMetadata?.name ?? packageNameForLockPath(lockPath);
    if (
      !currentMetadata ||
      typeof currentMetadata !== "object" ||
      !currentMetadata.version ||
      currentPackageName !== packageName ||
      !isStablePatchDrift(metadata.version, currentMetadata.version) ||
      !versionSatisfiesSimpleSpec(
        currentMetadata.version,
        dependencySpecForLockPath(generatedPackages, lockPath, packageName),
      ) ||
      !pnpmLockPackages.has(`${packageName}@${currentMetadata.version}`)
    )
      continue;
    generatedPackages[lockPath] = currentMetadata;
  }
  return generated;
}
