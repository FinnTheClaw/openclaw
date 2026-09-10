import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type FileEvidence =
  | { state: "present"; text: string; modifiedAt: string }
  | { state: "missing" }
  | { state: "unavailable"; reason: string };
export type MemorySnapshot = { files: Record<string, FileEvidence>; incomplete: boolean };
const ROOT_FILES = ["MEMORY.md", "USER.md", "AGENTS.md", "SOUL.md"];
const MAX_FILE_BYTES = 32_768;
const MAX_DAILY_FILES = 32;

// Only this explicit workspace memory surface is observed, at normal tool boundaries.
// Symlinks and oversized inputs are reported as missing evidence, never followed/truncated.
export function captureMemorySnapshot(workspace: string): MemorySnapshot {
  const files: Record<string, FileEvidence> = {};
  let incomplete = false;
  const names = [...ROOT_FILES];
  try {
    const directory = path.join(workspace, "memory");
    if (lstatSync(directory).isSymbolicLink()) {
      incomplete = true;
    } else {
      const daily = readdirSync(directory)
        .filter((name) => name.endsWith(".md"))
        .sort();
      incomplete = daily.length > MAX_DAILY_FILES;
      names.push(...daily.slice(0, MAX_DAILY_FILES).map((name) => "memory/" + name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
  }
  for (const name of names) {
    try {
      const filename = path.join(workspace, name);
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
        files[name] = { state: "unavailable", reason: "not a bounded regular file" };
        incomplete = true;
      } else {
        files[name] = {
          state: "present",
          text: readFileSync(filename, "utf8"),
          modifiedAt: stat.mtime.toISOString(),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files[name] = { state: "missing" };
      } else {
        files[name] = { state: "unavailable", reason: "read failed" };
        incomplete = true;
      }
    }
  }
  return { files, incomplete };
}

export function changedMemoryDelta(before: MemorySnapshot, after: MemorySnapshot) {
  const names = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  return names.flatMap((name) => {
    const previous = before.files[name] ?? { state: "missing" as const };
    const current = after.files[name] ?? { state: "missing" as const };
    // A touch is not a changed learning event.
    const same =
      previous.state === "present" && current.state === "present"
        ? previous.text === current.text
        : JSON.stringify(previous) === JSON.stringify(current);
    return same ? [] : [{ path: name, before: previous, after: current }];
  });
}
