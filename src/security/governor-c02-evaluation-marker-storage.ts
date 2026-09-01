import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  assertC02MarkerDirectoryStable,
  c02MarkerLeaf,
  createOrOpenC02MarkerChild,
  openC02MarkerDirectory,
  withC02MarkerAncestors,
  type C02MarkerDirectoryAnchor,
  type C02MarkerTestHooks,
} from "./governor-c02-evaluation-marker-anchor.js";
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

function withMarkerDirectory<T>(
  stateDir: string,
  action: (directory: C02MarkerDirectoryAnchor) => T,
  hooks?: C02MarkerTestHooks,
): T {
  const rootPath = path.resolve(stateDir);
  try {
    fs.mkdirSync(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const root = openC02MarkerDirectory(rootPath, true);
  try {
    const governor = createOrOpenC02MarkerChild(root, "governor", hooks);
    try {
      const openedMarker = createOrOpenC02MarkerChild(governor, MARKER_DIRECTORY, hooks);
      const marker = withC02MarkerAncestors(openedMarker, [root, governor]);
      try {
        hooks?.afterChildOpenBeforeLeafPublication?.();
        assertC02MarkerDirectoryStable(marker);
        return action(marker);
      } finally {
        fs.closeSync(marker.descriptor);
      }
    } finally {
      fs.closeSync(governor.descriptor);
    }
  } finally {
    fs.closeSync(root.descriptor);
  }
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

function markerPaths(evaluation: C02Evaluation) {
  const base = markerBase(evaluation);
  return { pending: `${base}.pending.json`, completed: `${base}.completed.json` };
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

function readMarker(
  directory: C02MarkerDirectoryAnchor,
  name: string,
  evaluation: C02Evaluation,
): "absent" | "valid" | "invalid" {
  const file = c02MarkerLeaf(directory, name);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants as Record<string, number>).O_NOFOLLOW,
    );
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
    const valid =
      Object.keys(marker).toSorted().join(",") === "caseId,family,kind,phase,requestNonce" &&
      marker.kind === "c02-eval-restart" &&
      marker.phase === "beta-complete" &&
      marker.caseId === evaluation.caseId &&
      marker.family === "F" &&
      marker.requestNonce === evaluation.requestNonce
        ? "valid"
        : "invalid";
    assertC02MarkerDirectoryStable(directory);
    return valid;
  } catch {
    return "invalid";
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: C02MarkerDirectoryAnchor): void {
  try {
    fs.fsyncSync(directory.descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "linux" ||
      !new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]).has(code ?? "")
    ) {
      throw error;
    }
  }
  assertC02MarkerDirectoryStable(directory);
}

function removeIfSameFile(directory: C02MarkerDirectoryAnchor, name: string): void {
  const file = c02MarkerLeaf(directory, name);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants as Record<string, number>).O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (!stat.isFile() || pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_FILE_INVALID");
    }
    assertC02MarkerDirectoryStable(directory);
    fs.unlinkSync(file);
    assertC02MarkerDirectoryStable(directory);
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

function inspectMarker(
  directory: C02MarkerDirectoryAnchor,
  evaluation: C02Evaluation,
): MarkerStatus {
  const paths = markerPaths(evaluation);
  const pending = readMarker(directory, paths.pending, evaluation);
  const completed = readMarker(directory, paths.completed, evaluation);
  if (pending === "invalid" || completed === "invalid") {
    return "invalid";
  }
  if (completed === "valid") {
    if (pending === "valid") {
      try {
        removeIfSameFile(directory, paths.pending);
        syncDirectory(directory);
      } catch {
        // Completed is authoritative; preserving it still fail-closes replay.
      }
    }
    return "completed";
  }
  return pending === "valid" ? "pending" : "none";
}

function cleanOrphansAndMakeRoom(directory: C02MarkerDirectoryAnchor): boolean {
  const now = Date.now();
  const owned: string[] = [];
  const directoryPath = c02MarkerLeaf(directory, ".");
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (OWNED_TEMP.test(entry.name)) {
      const stat = fs.lstatSync(c02MarkerLeaf(directory, entry.name));
      if (stat.isFile() && !stat.isSymbolicLink() && deadOwnedWriter(stat, entry.name, now)) {
        removeIfSameFile(directory, entry.name);
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
      const stat = fs.lstatSync(c02MarkerLeaf(directory, name));
      return stat.isFile() && !stat.isSymbolicLink() ? [{ name, mtimeMs: stat.mtimeMs }] : [];
    })
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let count = owned.length;
  for (const marker of completed) {
    if (count < MAX_MARKERS) {
      break;
    }
    removeIfSameFile(directory, marker.name);
    count -= 1;
  }
  if (count < MAX_MARKERS) {
    syncDirectory(directory);
  }
  return count < MAX_MARKERS;
}

function writePendingMarker(
  directory: C02MarkerDirectoryAnchor,
  evaluation: C02Evaluation,
): boolean {
  const paths = markerPaths(evaluation);
  if (inspectMarker(directory, evaluation) !== "none" || !cleanOrphansAndMakeRoom(directory)) {
    return false;
  }
  const tempName = `.${markerBase(evaluation)}.${process.pid}.${randomUUID()}.tmp`;
  const temporary = c02MarkerLeaf(directory, tempName);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants as Record<string, number>).O_NOFOLLOW,
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
    const pending = c02MarkerLeaf(directory, paths.pending);
    assertC02MarkerDirectoryStable(directory);
    fs.linkSync(temporary, pending);
    syncDirectory(directory);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      assertC02MarkerDirectoryStable(directory);
      fs.unlinkSync(temporary);
      syncDirectory(directory);
    } catch {}
  }
}

function completePendingMarker(
  directory: C02MarkerDirectoryAnchor,
  evaluation: C02Evaluation,
): boolean {
  const paths = markerPaths(evaluation);
  if (
    readMarker(directory, paths.pending, evaluation) !== "valid" ||
    readMarker(directory, paths.completed, evaluation) !== "absent"
  ) {
    return false;
  }
  try {
    const pending = c02MarkerLeaf(directory, paths.pending);
    const completed = c02MarkerLeaf(directory, paths.completed);
    assertC02MarkerDirectoryStable(directory);
    fs.linkSync(pending, completed);
    syncDirectory(directory);
    removeIfSameFile(directory, paths.pending);
    syncDirectory(directory);
    return readMarker(directory, paths.completed, evaluation) === "valid";
  } catch {
    return false;
  }
}

/** C02-only bounded restart state; completed files enforce a recent, immediate replay horizon. */
export function createC02EvaluationRestartMarkers(params?: {
  stateDir?: string;
  testHooks?: C02MarkerTestHooks;
}): C02EvaluationRestartMarkers {
  const claims = new Set<string>();
  const stateDir = params?.stateDir ?? resolveStateDir();
  return Object.freeze({
    start(evaluation) {
      if (!evaluation.restartAfterObserveB) {
        return Object.freeze({ generation: 0, resumed: false, blocked: false });
      }
      try {
        const marker = withMarkerDirectory(stateDir, (directory) =>
          inspectMarker(directory, evaluation),
        );
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
        return (
          generation === 0 &&
          withMarkerDirectory(
            stateDir,
            (directory) => writePendingMarker(directory, evaluation),
            params?.testHooks,
          )
        );
      } catch {
        return false;
      }
    },
    complete(evaluation, generation) {
      try {
        if (generation !== 1 || !claims.has(markerBase(evaluation))) {
          return false;
        }
        const completed = withMarkerDirectory(stateDir, (directory) =>
          completePendingMarker(directory, evaluation),
        );
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
        const marker = withMarkerDirectory(stateDir, (directory) =>
          inspectMarker(directory, evaluation),
        );
        return marker === "none" ? generation !== 0 : marker === "invalid" || generation !== 1;
      } catch {
        return true;
      }
    },
  });
}
