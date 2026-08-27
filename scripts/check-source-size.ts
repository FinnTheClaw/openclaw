import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

const MAX_LINES = 500;
const BASELINE_PATH = "scripts/source-size-baseline.json";
const IMMUTABLE_BASE_COMMIT = "e9030d5476e5572a44ba89f653bc5c6c428ea351";
const EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
]);
const SOURCE_ROOTS = new Set([
  "apps",
  "bin",
  "crates",
  "extensions",
  "lib",
  "packages",
  "scripts",
  "skills",
  "src",
  "test",
  "tests",
  "tools",
  "ui",
  "web",
]);
const EXCLUDED_ROOTS = new Set([
  ".artifacts",
  ".git",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

type Baseline = { baseCommit: string; schemaVersion: 1 };
type Change = { baselinePath?: string; kind: "existing" | "new"; path: string };
type Language = "hash" | "js" | "rust";
type LexState =
  | { kind: "block" }
  | { kind: "code" }
  | { kind: "double" }
  | { kind: "pythonTripleDouble" }
  | { kind: "pythonTripleSingle" }
  | { kind: "rustChar" }
  | { closing: string; kind: "rustRaw" }
  | { kind: "single" }
  | { kind: "template" };

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitBuffer(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

function gitExitCode(args: string[], cwd: string): number {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

function repositoryRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
}

function validatePath(filePath: string): void {
  const parts = filePath.split("/");
  const hasControlCharacter = [...filePath].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !filePath ||
    isAbsolute(filePath) ||
    filePath.includes("\\") ||
    hasControlCharacter ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`malformed repository path: ${JSON.stringify(filePath)}`);
  }
}

function isSourceLocation(filePath: string): boolean {
  const parts = filePath.split("/");
  if (EXCLUDED_ROOTS.has(parts[0])) {
    return false;
  }
  return parts.length === 1 || parts.some((part) => SOURCE_ROOTS.has(part));
}

function languageFor(filePath: string, content: string): Language {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".rs") {
    return "rust";
  }
  if ([".pl", ".ps1", ".py", ".rb", ".sh"].includes(extension)) {
    return "hash";
  }
  if (!extension && /^#!.*(?:python|ruby|perl|pwsh|powershell|sh|bash|zsh|fish)/u.test(content)) {
    return "hash";
  }
  return "js";
}

function decode(buffer: Buffer, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`governed source is not valid UTF-8: ${filePath}`);
  }
}

function parseBaseline(value: unknown): Baseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source-size baseline must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.join(",") !== "baseCommit,schemaVersion") {
    throw new Error("source-size baseline may contain only baseCommit and schemaVersion");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("source-size baseline schemaVersion must be 1");
  }
  if (typeof record.baseCommit !== "string" || !/^[0-9a-f]{40}$/u.test(record.baseCommit)) {
    throw new Error("source-size baseline baseCommit must be a full lowercase commit SHA");
  }
  if (record.baseCommit !== IMMUTABLE_BASE_COMMIT) {
    throw new Error("source-size baseline baseCommit must match the immutable source-GO skeleton");
  }
  return record as Baseline;
}

async function loadBaseline(root: string): Promise<Baseline> {
  return parseBaseline(JSON.parse(await readFile(join(root, BASELINE_PATH), "utf8")) as unknown);
}

function assertImmutableBase(root: string, baseCommit: string): void {
  const resolved = git(["rev-parse", `${baseCommit}^{commit}`], root).trim();
  if (
    resolved !== baseCommit ||
    gitExitCode(["merge-base", "--is-ancestor", baseCommit, "HEAD"], root) !== 0
  ) {
    throw new Error("source-size baseCommit must resolve exactly to an ancestor of HEAD");
  }
}

function parseNameStatus(raw: string): Change[] {
  const tokens = raw.split("\0");
  const changes = new Map<string, Change>();
  for (let index = 0; index < tokens.length - 1; ) {
    const status = tokens[index++];
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      changes.set(
        newPath,
        code === "R"
          ? { baselinePath: oldPath, kind: "existing", path: newPath }
          : { kind: "new", path: newPath },
      );
      continue;
    }
    const filePath = tokens[index++];
    if (code !== "D") {
      changes.set(filePath, { kind: code === "A" ? "new" : "existing", path: filePath });
    }
  }
  return [...changes.values()];
}

function untrackedPaths(root: string): string[] {
  const ordinary = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root);
  return `${ordinary}${ignored}`.split("\0").filter(Boolean);
}

function collectChanges(root: string, baseCommit: string): Change[] {
  const raw = git(["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"], root);
  const changes = parseNameStatus(raw);
  const seen = new Set(changes.map((change) => change.path));
  for (const filePath of untrackedPaths(root)) {
    if (!seen.has(filePath)) {
      changes.push({ kind: "new", path: filePath });
      seen.add(filePath);
    }
  }
  for (const change of changes) {
    validatePath(change.path);
    if (change.baselinePath) {
      validatePath(change.baselinePath);
    }
  }
  return changes.filter((change) => isSourceLocation(change.path));
}

function beginsRustRaw(line: string, index: number): string | undefined {
  const match = /^(?:br|r)(#*)"/u.exec(line.slice(index));
  return match ? `"${match[1]}` : undefined;
}

function countNonCommentLines(content: string, language: Language): number {
  let state: LexState = { kind: "code" };
  let count = 0;
  for (const line of content.split(/\r?\n/u)) {
    let hasCode = state.kind !== "code" && state.kind !== "block";
    for (let index = 0; index < line.length; ) {
      if (state.kind === "block") {
        const end = line.indexOf("*/", index);
        if (end === -1) {
          break;
        }
        state = { kind: "code" };
        index = end + 2;
        continue;
      }
      if (state.kind === "pythonTripleSingle" || state.kind === "pythonTripleDouble") {
        hasCode = true;
        const closing = state.kind === "pythonTripleSingle" ? "'''" : '"""';
        const end = line.indexOf(closing, index);
        if (end === -1) {
          break;
        }
        state = { kind: "code" };
        index = end + 3;
        continue;
      }
      if (state.kind === "rustRaw") {
        hasCode = true;
        const end = line.indexOf(state.closing, index);
        if (end === -1) {
          break;
        }
        index = end + state.closing.length;
        state = { kind: "code" };
        continue;
      }
      if (["single", "double", "template", "rustChar"].includes(state.kind)) {
        hasCode = true;
        const closing = state.kind === "double" ? '"' : state.kind === "template" ? "`" : "'";
        if (line[index] === "\\") {
          index += 2;
        } else if (line[index] === closing) {
          state = { kind: "code" };
          index++;
        } else {
          index++;
        }
        continue;
      }

      const character = line[index];
      if (/\s/u.test(character)) {
        index++;
        continue;
      }
      if ((language === "js" || language === "rust") && line.startsWith("//", index)) {
        break;
      }
      if ((language === "js" || language === "rust") && line.startsWith("/*", index)) {
        state = { kind: "block" };
        index += 2;
        continue;
      }
      if (language === "hash" && character === "#") {
        if (index === 0 && line.startsWith("#!")) {
          hasCode = true;
        }
        break;
      }
      if (language === "rust") {
        const rawClosing = beginsRustRaw(line, index);
        if (rawClosing) {
          hasCode = true;
          state = { closing: rawClosing, kind: "rustRaw" };
          index += rawClosing.length + (line[index] === "b" ? 2 : 1);
          continue;
        }
      }
      if (language === "hash" && (line.startsWith("'''", index) || line.startsWith('"""', index))) {
        hasCode = true;
        state = { kind: line[index] === "'" ? "pythonTripleSingle" : "pythonTripleDouble" };
        index += 3;
        continue;
      }
      if (character === "'") {
        hasCode = true;
        state = { kind: language === "rust" ? "rustChar" : "single" };
        index++;
        continue;
      }
      if (character === '"') {
        hasCode = true;
        state = { kind: "double" };
        index++;
        continue;
      }
      if (character === "`") {
        hasCode = true;
        state = { kind: "template" };
        index++;
        continue;
      }
      hasCode = true;
      index++;
    }
    if (hasCode) {
      count++;
    }
  }
  return count;
}

async function readCandidate(
  root: string,
  filePath: string,
): Promise<{ content: string; executable: boolean }> {
  const absolutePath = join(root, filePath);
  const before = await lstat(absolutePath);
  if (!before.isFile()) {
    throw new Error(`governed path must be a regular file: ${filePath}`);
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`governed path changed during inspection: ${filePath}`);
    }
    return {
      content: decode(await handle.readFile(), filePath),
      executable: (after.mode & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}

function isGoverned(filePath: string, content: string, executable: boolean): boolean {
  const extension = extname(filePath).toLowerCase();
  return EXTENSIONS.has(extension) || (!extension && (executable || content.startsWith("#!")));
}

function countBase(root: string, baseCommit: string, filePath: string): number {
  const content = decode(gitBuffer(["show", `${baseCommit}:${filePath}`], root), filePath);
  return countNonCommentLines(content, languageFor(filePath, content));
}

async function check(root: string, baseline: Baseline): Promise<number> {
  const failures: string[] = [];
  let checked = 0;
  for (const change of collectChanges(root, baseline.baseCommit).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const extension = extname(change.path).toLowerCase();
    if (extension && !EXTENSIONS.has(extension)) {
      continue;
    }
    const candidate = await readCandidate(root, change.path);
    if (!isGoverned(change.path, candidate.content, candidate.executable)) {
      continue;
    }
    checked++;
    const language = languageFor(change.path, candidate.content);
    const lines = countNonCommentLines(candidate.content, language);
    const baseLines =
      change.kind === "existing"
        ? countBase(root, baseline.baseCommit, change.baselinePath ?? change.path)
        : MAX_LINES;
    const limit = Math.max(MAX_LINES, baseLines);
    if (lines > limit) {
      failures.push(`${lines}\t${limit}\t${change.kind}\t${change.path}`);
    }
  }
  if (failures.length) {
    process.stderr.write("non-comment-lines\tlimit\tkind\tpath\n");
    process.stderr.write(`${failures.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`source-size-check: ${checked} changed governed files within limits\n`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    throw new Error("usage: check-source-size.ts");
  }
  const root = repositoryRoot();
  const baseline = await loadBaseline(root);
  assertImmutableBase(root, baseline.baseCommit);
  return check(root, baseline);
}

void main().then(
  (exitCode) => process.exit(exitCode),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
