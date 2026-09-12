import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_BYTES = 1024 * 1024;
type Snapshot = { kind: "read"; text: string } | { kind: "unverified" };
export type MemoryAttempt = { target: string; before: Snapshot };
const MEMORY_FILES = new Set(["MEMORY.md", "USER.md", "AGENTS.md", "SOUL.md"]);

function within(root: string, target: string) {
  const child = relative(root, target);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

export function memoryTarget(workspace: string, args: Record<string, unknown>, cwd = workspace) {
  const path = args.path ?? args.file_path;
  // Special native path expansion is not reimplemented by this advisory.
  if (typeof path !== "string" || !path || /^(?:@|~|file:)/.test(path)) return;
  const target = resolve(cwd, path);
  const child = relative(resolve(workspace), target);
  if (!within(resolve(workspace), target)) return;
  if (!MEMORY_FILES.has(child) && !(child.startsWith("memory" + sep) && child.endsWith(".md")))
    return;
  return target;
}

function readMemory(target: string, workspace: string): Snapshot {
  let fd: number | undefined;
  try {
    if (!within(realpathSync(workspace), realpathSync(target))) return { kind: "unverified" };
    fd = openSync(target, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { kind: "unverified" };
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) return { kind: "unverified" };
    const data = bytes.subarray(0, length);
    const text = data.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(data)) return { kind: "unverified" };
    return { kind: "read", text };
  } catch {
    return { kind: "unverified" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function captureMemoryAttempt(workspace: string, target: string): MemoryAttempt {
  return { target, before: readMemory(target, workspace) };
}

function expectedEdit(before: string, args: Record<string, unknown>): string | undefined {
  let edits = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return;
    }
  }
  const entries: unknown[] = Array.isArray(edits) ? [...edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    entries.push({ oldText: args.oldText, newText: args.newText });
  }
  if (!entries.length) return;
  // Native fuzzy matching/BOM/line-ending restoration stays owner-native.
  // Only exact non-overlapping LF edits receive our independent byte-match receipt.
  if (before.includes("\r") || before.startsWith("\uFEFF")) return;
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const entry of entries) {
    const edit = asRecord(entry);
    if (
      typeof edit?.oldText !== "string" ||
      !edit.oldText ||
      typeof edit.newText !== "string" ||
      edit.oldText.includes("\r") ||
      edit.newText.includes("\r")
    )
      return;
    const start = before.indexOf(edit.oldText);
    if (start < 0 || before.indexOf(edit.oldText, start + 1) !== -1) return;
    replacements.push({ start, end: start + edit.oldText.length, text: edit.newText });
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].start < replacements[i - 1].end) return;
  }
  let expected = before;
  for (const replacement of replacements.reverse()) {
    expected =
      expected.slice(0, replacement.start) + replacement.text + expected.slice(replacement.end);
  }
  return expected;
}

export function memoryReceipt(params: {
  workspace: string;
  target: string;
  toolName: string;
  args: Record<string, unknown>;
  attempt?: MemoryAttempt;
  isError?: boolean;
}) {
  const { workspace, target, toolName, args, attempt, isError } = params;
  const before = attempt?.target === target ? attempt.before : undefined;
  const expected =
    toolName === "write"
      ? typeof args.content === "string" && Buffer.byteLength(args.content, "utf8") <= MAX_BYTES
        ? args.content
        : undefined
      : before?.kind === "read"
        ? expectedEdit(before.text, args)
        : undefined;
  const after = readMemory(target, workspace);
  let status: "match" | "no-op" | "mismatch" | "unverified" = "unverified";
  let reason =
    "Expected bytes or local readback unavailable; underlying tool outcome is unchanged.";
  if (expected !== undefined && after.kind === "read") {
    if (after.text === expected) {
      status = before?.kind === "read" && before.text === after.text ? "no-op" : "match";
      reason =
        status === "no-op"
          ? "Requested bytes already present; no new change observed."
          : "Readback bytes match the requested operation at this boundary.";
    } else {
      status = "mismatch";
      reason =
        "Readback differs from intended bytes. Inspect before retrying or claiming persistence.";
    }
  }
  if (isError) reason += " Native tool reported an error; inspect its original result.";
  return (
    "[Memory readback receipt — advisory]\n" +
    JSON.stringify({
      target,
      operation: toolName,
      status,
      nativeToolError: isError === true,
      reason,
    }) +
    "\nThis verifies file bytes, not whether the interpretation is correct; concurrent writer identity is not proven."
  );
}
