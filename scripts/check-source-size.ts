import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

const MAX_LINES = 500;
const BASELINE_PATH = "scripts/source-size-baseline.json";
const IMMUTABLE_BASE_COMMIT = "e9030d5476e5572a44ba89f653bc5c6c428ea351";
const EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".cts",
  ".fish",
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
  ".swift",
  ".ts",
  ".tsx",
  ".zsh",
]);
const GENERATED_UNTRACKED_ROOTS = new Set([
  ".artifacts",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "dist-runtime",
  "node_modules",
]);

type Baseline = {
  baseCommit: string;
  schemaVersion: 1;
};
type Change = {
  baselinePath?: string;
  kind: "existing" | "new";
  origin: "diff" | "untracked";
  path: string;
};
type IndexEntry = { mode: string; objectId: string; path: string; stage: string };
type Representation = { governed: boolean; lines: number; source: "index" | "worktree" };

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

function decode(buffer: Buffer, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`governed source is not valid UTF-8: ${filePath}`);
  }
}

function countNonblankLines(content: string): number {
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\u2028", "\n")
    .replaceAll("\u2029", "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function isGoverned(filePath: string, executable: boolean, shebang: boolean): boolean {
  return EXTENSIONS.has(extname(filePath).toLowerCase()) || executable || shebang;
}

function parseBaseline(value: unknown): Baseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source-size baseline must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join(",") !== "baseCommit,schemaVersion") {
    throw new Error("source-size baseline has unsupported fields");
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
    if (!["A", "C", "D", "M", "R", "T"].includes(code)) {
      throw new Error(`unsupported or malformed Git name-status record: ${JSON.stringify(status)}`);
    }
    if (code === "R" || code === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        throw new Error(`incomplete Git ${code} name-status record`);
      }
      changes.set(
        newPath,
        code === "R"
          ? { baselinePath: oldPath, kind: "existing", origin: "diff", path: newPath }
          : { kind: "new", origin: "diff", path: newPath },
      );
      continue;
    }
    const filePath = tokens[index++];
    if (!filePath) {
      throw new Error(`incomplete Git ${code} name-status record`);
    }
    if (code !== "D") {
      changes.set(filePath, {
        kind: code === "A" ? "new" : "existing",
        origin: "diff",
        path: filePath,
      });
    }
  }
  return [...changes.values()];
}

function collectSnapshotChanges(
  root: string,
  baseCommit: string,
  source: "index" | "worktree",
): Change[] {
  const diffArguments = ["diff"];
  if (source === "index") {
    diffArguments.push("--cached");
  }
  diffArguments.push("--name-status", "-z", "--find-renames", baseCommit, "--");
  const byPath = new Map(
    parseNameStatus(git(diffArguments, root)).map((change) => [change.path, change]),
  );
  if (source === "worktree") {
    const ordinary = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root);
    for (const filePath of `${ordinary}${ignored}`.split("\0").filter(Boolean)) {
      if (!byPath.has(filePath)) {
        byPath.set(filePath, { kind: "new", origin: "untracked", path: filePath });
      }
    }
  }
  const changes = [...byPath.values()];
  for (const change of changes) {
    validatePath(change.path);
    if (change.baselinePath) {
      validatePath(change.baselinePath);
    }
  }
  return changes.filter(
    (change) =>
      change.origin === "diff" ||
      !change.path.split("/").some((component) => GENERATED_UNTRACKED_ROOTS.has(component)),
  );
}

function parseIndexEntries(root: string): Map<string, IndexEntry[]> {
  const entries = new Map<string, IndexEntry[]>();
  for (const record of git(["ls-files", "--stage", "-z"], root).split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const metadata = separator > 0 ? record.slice(0, separator).split(" ") : [];
    const filePath = separator > 0 ? record.slice(separator + 1) : "";
    if (metadata.length !== 3 || !filePath) {
      throw new Error(`malformed Git index record: ${JSON.stringify(record)}`);
    }
    validatePath(filePath);
    const entry = { mode: metadata[0], objectId: metadata[1], path: filePath, stage: metadata[2] };
    entries.set(filePath, [...(entries.get(filePath) ?? []), entry]);
  }
  return entries;
}

function readGitBlob(root: string, objectId: string, filePath: string): Buffer {
  if (
    !/^[0-9a-f]{40,64}$/u.test(objectId) ||
    git(["cat-file", "-t", objectId], root).trim() !== "blob"
  ) {
    throw new Error(`Git object is not a valid blob for ${filePath}`);
  }
  return gitBuffer(["cat-file", "blob", objectId], root);
}

function indexRepresentation(
  root: string,
  entries: IndexEntry[] | undefined,
): Representation | undefined {
  if (!entries) {
    return undefined;
  }
  if (entries.length !== 1 || entries[0].stage !== "0") {
    throw new Error(
      `unmerged or duplicate Git index stages for ${entries[0]?.path ?? "unknown path"}`,
    );
  }
  const entry = entries[0];
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    throw new Error(`Git index path is not a regular blob: ${entry.path} mode=${entry.mode}`);
  }
  const buffer = readGitBlob(root, entry.objectId, entry.path);
  const shebang = buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
  const governed = isGoverned(entry.path, entry.mode === "100755", shebang);
  return {
    governed,
    lines: governed ? countNonblankLines(decode(buffer, entry.path)) : 0,
    source: "index",
  };
}

async function worktreeRepresentation(
  root: string,
  filePath: string,
): Promise<Representation | undefined> {
  const absolutePath = join(root, filePath);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!before.isFile()) {
    throw new Error(`working-tree path is not a regular file: ${filePath}`);
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) {
      throw new Error(`working-tree path changed during inspection: ${filePath}`);
    }
    const buffer = await handle.readFile();
    const read = await handle.stat();
    const after = await lstat(absolutePath);
    if (!sameFile(opened, read) || !sameFile(read, after)) {
      throw new Error(`working-tree path changed during inspection: ${filePath}`);
    }
    const shebang = buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
    const governed = isGoverned(filePath, (read.mode & 0o111) !== 0, shebang);
    return {
      governed,
      lines: governed ? countNonblankLines(decode(buffer, filePath)) : 0,
      source: "worktree",
    };
  } finally {
    await handle.close();
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function baseAllowance(
  root: string,
  baseCommit: string,
  filePath: string,
): { governed: boolean; lines: number } {
  const rawRecord = git(["ls-tree", "-z", baseCommit, "--", filePath], root);
  const record = rawRecord.endsWith("\0") ? rawRecord.slice(0, -1) : rawRecord;
  const separator = record.indexOf("\t");
  const metadata = separator > 0 ? record.slice(0, separator).split(" ") : [];
  if (
    metadata.length !== 3 ||
    metadata[1] !== "blob" ||
    !["100644", "100755"].includes(metadata[0])
  ) {
    throw new Error(`immutable base path is not a regular blob: ${filePath}`);
  }
  const buffer = readGitBlob(root, metadata[2], filePath);
  const shebang = buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
  const governed = isGoverned(filePath, metadata[0] === "100755", shebang);
  return {
    governed,
    lines: governed ? countNonblankLines(decode(buffer, filePath)) : 0,
  };
}

async function check(root: string, baseline: Baseline): Promise<number> {
  const failures: string[] = [];
  const index = parseIndexEntries(root);
  let checked = 0;
  for (const source of ["index", "worktree"] as const) {
    const changes = collectSnapshotChanges(root, baseline.baseCommit, source).toSorted((a, b) =>
      a.path.localeCompare(b.path),
    );
    for (const change of changes) {
      const representation =
        source === "index"
          ? indexRepresentation(root, index.get(change.path))
          : await worktreeRepresentation(root, change.path);
      if (!representation?.governed) {
        continue;
      }
      checked++;
      const base =
        change.kind === "existing"
          ? baseAllowance(root, baseline.baseCommit, change.baselinePath ?? change.path)
          : undefined;
      const limit = base?.governed ? Math.max(MAX_LINES, base.lines) : MAX_LINES;
      if (representation.lines > limit) {
        failures.push(
          `${representation.lines}\t${limit}\t${change.kind}\t${representation.source}\t${change.path}`,
        );
      }
    }
  }
  if (failures.length) {
    process.stderr.write("nonblank-lines\tlimit\tkind\trepresentation\tpath\n");
    process.stderr.write(`${failures.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(
    `source-size-check: ${checked} changed governed representations within nonblank limits\n`,
  );
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
