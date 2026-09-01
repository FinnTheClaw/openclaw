import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { assertNoSymlinkParentsSync } from "../infra/fs-safe-advanced.js";
import type { C02Evaluation } from "./governor-c02-evaluation.js";

const MAX_MARKER_BYTES = 256;
const MAX_MARKERS = 128;
const TEMP_STALE_MS = 5 * 60 * 1000;
const MARKER_DIRECTORY = "c02-eval-restarts";
const OWNED_MARKER = /^c02-f-[0-9]{3}-[a-f0-9]{24}\.(?:pending|completed)\.json$/u;
const OWNED_COMPLETED = /^c02-f-[0-9]{3}-[a-f0-9]{24}\.completed\.json$/u;
const OWNED_TEMP = /^\.c02-f-[0-9]{3}-[a-f0-9]{24}\.([0-9]+)\.[a-f0-9-]{36}\.tmp$/u;

type RestartMarker = Readonly<{
  kind: "c02-eval-restart";
  phase: "beta-complete";
  caseId: string;
  family: "F";
  requestNonce: string;
}>;
type MarkerStatus = "none" | "pending" | "completed" | "invalid";

export type C02EvaluationRestartMarkers = Readonly<{
  start: (
    evaluation: C02Evaluation,
  ) => Readonly<{ generation: number; resumed: boolean; blocked: boolean }>;
  arm: (evaluation: C02Evaluation, generation: number) => boolean;
  complete: (evaluation: C02Evaluation, generation: number) => boolean;
  release: (evaluation: C02Evaluation, generation: number) => void;
  isStale: (evaluation: C02Evaluation, generation: number) => boolean;
}>;

function sameEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollow(): number {
  const flag = fs.constants.O_NOFOLLOW;
  if (typeof flag !== "number") {
    throw new Error("C02_RESTART_MARKER_NOFOLLOW_UNAVAILABLE");
  }
  return flag;
}

function openDirectory(directory: string, privateMode: boolean): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow());
  try {
    let stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(directory);
    if (!stat.isDirectory() || pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_DIRECTORY_INVALID");
    }
    if (privateMode) {
      fs.fchmodSync(descriptor, 0o700);
      stat = fs.fstatSync(descriptor);
      const finalPathStat = fs.lstatSync(directory);
      if (
        (stat.mode & 0o077) !== 0 ||
        finalPathStat.isSymbolicLink() ||
        !sameEntry(stat, finalPathStat)
      ) {
        throw new Error("C02_RESTART_MARKER_DIRECTORY_PERMISSIONS_INVALID");
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  openDirectory(directory, true);
}

function assertSafeParents(rootDir: string, directory: string): void {
  assertNoSymlinkParentsSync({
    rootDir,
    targetPath: directory,
    allowMissing: true,
    allowRootChildSymlink: false,
    requireDirectories: true,
    messagePrefix: "C02 restart marker path",
  });
}

function markerDirectory(stateDir: string): string {
  const root = path.resolve(stateDir);
  const governor = path.join(root, "governor");
  const directory = path.join(governor, MARKER_DIRECTORY);
  if (path.relative(root, directory).startsWith("..")) {
    throw new Error("C02_RESTART_MARKER_PATH_INVALID");
  }
  ensurePrivateDirectory(root);
  assertSafeParents(root, governor);
  ensurePrivateDirectory(governor);
  assertSafeParents(root, directory);
  ensurePrivateDirectory(directory);
  return directory;
}

function assertRestartEvaluation(evaluation: C02Evaluation): void {
  if (
    !evaluation.restartAfterObserveB ||
    evaluation.family !== "F" ||
    !/^C02-F-[0-9]{3}$/u.test(evaluation.caseId) ||
    !/^[a-f0-9]{24}$/u.test(evaluation.requestNonce)
  ) {
    throw new Error("C02_RESTART_MARKER_FAMILY_INVALID");
  }
}

function markerBase(evaluation: C02Evaluation): string {
  assertRestartEvaluation(evaluation);
  return `${evaluation.caseId.toLowerCase()}-${evaluation.requestNonce}`;
}

function markerPaths(directory: string, evaluation: C02Evaluation) {
  const base = markerBase(evaluation);
  return {
    pending: path.join(directory, `${base}.pending.json`),
    completed: path.join(directory, `${base}.completed.json`),
  };
}

function markerPayload(evaluation: C02Evaluation): RestartMarker {
  assertRestartEvaluation(evaluation);
  return Object.freeze({
    kind: "c02-eval-restart",
    phase: "beta-complete",
    caseId: evaluation.caseId,
    family: "F",
    requestNonce: evaluation.requestNonce,
  });
}

function readMarker(file: string, evaluation: C02Evaluation): "absent" | "valid" | "invalid" {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow());
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid";
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameEntry(stat, pathStat) ||
      stat.size > MAX_MARKER_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      return "invalid";
    }
    const marker = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Partial<RestartMarker>;
    return Object.keys(marker).toSorted().join(",") === "caseId,family,kind,phase,requestNonce" &&
      marker.kind === "c02-eval-restart" &&
      marker.phase === "beta-complete" &&
      marker.caseId === evaluation.caseId &&
      marker.family === "F" &&
      marker.requestNonce === evaluation.requestNonce
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow());
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(directory);
    if (!stat.isDirectory() || pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_DIRECTORY_INVALID");
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "linux" ||
      !new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]).has(code ?? "")
    ) {
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeIfSameFile(file: string): void {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow());
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (!stat.isFile() || pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_FILE_INVALID");
    }
    fs.unlinkSync(file);
  } finally {
    fs.closeSync(descriptor);
  }
}

function deadOwnedWriter(stat: fs.Stats, name: string, now: number): boolean {
  const match = OWNED_TEMP.exec(name);
  const currentUid = process.getuid?.();
  if (
    !match ||
    stat.mtimeMs > now - TEMP_STALE_MS ||
    (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    return false;
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function inspectMarker(directory: string, evaluation: C02Evaluation): MarkerStatus {
  const paths = markerPaths(directory, evaluation);
  const pending = readMarker(paths.pending, evaluation);
  const completed = readMarker(paths.completed, evaluation);
  if (pending === "invalid" || completed === "invalid") {
    return "invalid";
  }
  if (completed === "valid") {
    if (pending === "valid") {
      try {
        removeIfSameFile(paths.pending);
        syncDirectory(directory);
      } catch {
        // Completed remains authoritative; the only safe result is still a replay block.
      }
    }
    return "completed";
  }
  return pending === "valid" ? "pending" : "none";
}

function cleanOrphansAndMakeRoom(directory: string): boolean {
  const now = Date.now();
  const owned: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (OWNED_TEMP.test(entry.name)) {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && deadOwnedWriter(stat, entry.name, now)) {
        removeIfSameFile(file);
      }
    }
    if (OWNED_MARKER.test(entry.name)) {
      owned.push(entry.name);
    }
  }
  if (owned.length < MAX_MARKERS) {
    return true;
  }
  const completed = owned
    .filter((name) => OWNED_COMPLETED.test(name))
    .flatMap((name) => {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, mtimeMs: stat.mtimeMs }] : [];
    })
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.file.localeCompare(right.file));
  let count = owned.length;
  for (const marker of completed) {
    if (count < MAX_MARKERS) {
      break;
    }
    removeIfSameFile(marker.file);
    count -= 1;
  }
  if (count < MAX_MARKERS) {
    syncDirectory(directory);
  }
  return count < MAX_MARKERS;
}

function writePendingMarker(directory: string, evaluation: C02Evaluation): boolean {
  const paths = markerPaths(directory, evaluation);
  if (inspectMarker(directory, evaluation) !== "none" || !cleanOrphansAndMakeRoom(directory)) {
    return false;
  }
  const temporary = path.join(
    directory,
    `.${markerBase(evaluation)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow(),
      0o600,
    );
    fs.writeFileSync(descriptor, JSON.stringify(markerPayload(evaluation)), "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(temporary);
    if (!stat.isFile() || pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      return false;
    }
    fs.linkSync(temporary, paths.pending);
    syncDirectory(directory);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporary);
      syncDirectory(directory);
    } catch {}
  }
}

function completePendingMarker(directory: string, evaluation: C02Evaluation): boolean {
  const paths = markerPaths(directory, evaluation);
  if (
    readMarker(paths.pending, evaluation) !== "valid" ||
    readMarker(paths.completed, evaluation) !== "absent"
  ) {
    return false;
  }
  try {
    fs.linkSync(paths.pending, paths.completed);
    syncDirectory(directory);
    removeIfSameFile(paths.pending);
    syncDirectory(directory);
    return readMarker(paths.completed, evaluation) === "valid";
  } catch {
    return false;
  }
}

/** C02-only bounded restart state; completed markers are a recent replay horizon, not eternal history. */
export function createC02EvaluationRestartMarkers(params?: {
  stateDir?: string;
}): C02EvaluationRestartMarkers {
  const claims = new Set<string>();
  const directory = () => markerDirectory(params?.stateDir ?? resolveStateDir());
  return Object.freeze({
    start(evaluation) {
      if (!evaluation.restartAfterObserveB) {
        return Object.freeze({ generation: 0, resumed: false, blocked: false });
      }
      try {
        const marker = inspectMarker(directory(), evaluation);
        if (marker === "none") {
          return Object.freeze({ generation: 0, resumed: false, blocked: false });
        }
        if (marker !== "pending" || claims.has(markerBase(evaluation))) {
          return Object.freeze({ generation: 1, resumed: false, blocked: true });
        }
        claims.add(markerBase(evaluation));
        return Object.freeze({ generation: 1, resumed: true, blocked: false });
      } catch {
        return Object.freeze({ generation: 1, resumed: false, blocked: true });
      }
    },
    arm(evaluation, generation) {
      try {
        return generation === 0 && writePendingMarker(directory(), evaluation);
      } catch {
        return false;
      }
    },
    complete(evaluation, generation) {
      try {
        if (generation !== 1 || !claims.has(markerBase(evaluation))) {
          return false;
        }
        const completed = completePendingMarker(directory(), evaluation);
        if (completed) {
          claims.delete(markerBase(evaluation));
        }
        return completed;
      } catch {
        return false;
      }
    },
    release(evaluation, generation) {
      if (generation === 1) {
        claims.delete(markerBase(evaluation));
      }
    },
    isStale(evaluation, generation) {
      if (!evaluation.restartAfterObserveB) {
        return false;
      }
      try {
        const marker = inspectMarker(directory(), evaluation);
        return marker === "none" ? generation !== 0 : marker === "invalid" || generation !== 1;
      } catch {
        return true;
      }
    },
  });
}
