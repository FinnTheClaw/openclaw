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
const HASH_COMMENT_EXTENSIONS = new Set([
  ".bash",
  ".fish",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".zsh",
]);
const SLASH_COMMENT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);
const GENERATED_UNTRACKED_ROOTS = new Set([
  ".artifacts",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

type Baseline = { baseCommit: string; schemaVersion: 1 };
type Change = {
  baselinePath?: string;
  kind: "existing" | "new";
  origin: "diff" | "untracked";
  path: string;
};
type CommentStyle = "hash" | "none" | "slash";
type Candidate = { content: string; style: CommentStyle };

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

function parseBaseline(value: unknown): Baseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source-size baseline must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join(",") !== "baseCommit,schemaVersion") {
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
          ? { baselinePath: oldPath, kind: "existing", origin: "diff", path: newPath }
          : { kind: "new", origin: "diff", path: newPath },
      );
      continue;
    }
    const filePath = tokens[index++];
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

function collectChanges(root: string, baseCommit: string): Change[] {
  const raw = git(["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"], root);
  const changes = parseNameStatus(raw);
  const seen = new Set(changes.map((change) => change.path));
  const ordinary = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root);
  for (const filePath of `${ordinary}${ignored}`.split("\0").filter(Boolean)) {
    if (!seen.has(filePath)) {
      changes.push({ kind: "new", origin: "untracked", path: filePath });
      seen.add(filePath);
    }
  }
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

function indexExecutableModes(root: string): Map<string, boolean> {
  const modes = new Map<string, boolean>();
  for (const record of git(["ls-files", "--stage", "-z"], root).split("\0")) {
    const separator = record.indexOf("\t");
    if (separator > 0) {
      modes.set(record.slice(separator + 1), record.startsWith("100755 "));
    }
  }
  return modes;
}

function styleFor(filePath: string, content: string): CommentStyle {
  const extension = extname(filePath).toLowerCase();
  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    return "hash";
  }
  if (SLASH_COMMENT_EXTENSIONS.has(extension)) {
    return "slash";
  }
  const firstLine = content.split("\n", 1)[0].toLowerCase();
  const hashRuntimes = [
    "python",
    "ruby",
    "perl",
    "pwsh",
    "powershell",
    "sh",
    "bash",
    "zsh",
    "fish",
  ];
  if (firstLine.startsWith("#!") && hashRuntimes.some((runtime) => firstLine.includes(runtime))) {
    return "hash";
  }
  if (
    firstLine.startsWith("#!") &&
    ["node", "deno", "bun"].some((runtime) => firstLine.includes(runtime))
  ) {
    return "slash";
  }
  return "none";
}

function isWholeLineComment(trimmed: string, style: CommentStyle): boolean {
  if (style === "slash") {
    return trimmed.startsWith("//");
  }
  if (style === "hash") {
    return trimmed.startsWith("#") && !trimmed.startsWith("#!");
  }
  return false;
}

function countLines(content: string, style: CommentStyle): number {
  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !isWholeLineComment(trimmed, style)) {
      count++;
    }
  }
  return count;
}

async function inspectCandidate(
  root: string,
  filePath: string,
  indexExecutable: boolean,
): Promise<Candidate | undefined> {
  const absolutePath = join(root, filePath);
  const before = await lstat(absolutePath);
  if (!before.isFile()) {
    throw new Error(`changed path must be a regular file: ${filePath}`);
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`changed path changed during inspection: ${filePath}`);
    }
    const prefix = Buffer.alloc(2);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const shebang = bytesRead === 2 && prefix[0] === 0x23 && prefix[1] === 0x21;
    const executable = (after.mode & 0o111) !== 0 || indexExecutable;
    const extension = extname(filePath).toLowerCase();
    if (!shebang && !executable && !EXTENSIONS.has(extension)) {
      return undefined;
    }
    const content = decode(await handle.readFile(), filePath);
    return { content, style: styleFor(filePath, content) };
  } finally {
    await handle.close();
  }
}

function countBase(root: string, baseCommit: string, filePath: string): number {
  const content = decode(gitBuffer(["show", `${baseCommit}:${filePath}`], root), filePath);
  return countLines(content, styleFor(filePath, content));
}

async function check(root: string, baseline: Baseline): Promise<number> {
  const failures: string[] = [];
  const indexModes = indexExecutableModes(root);
  let checked = 0;
  for (const change of collectChanges(root, baseline.baseCommit).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const candidate = await inspectCandidate(
      root,
      change.path,
      indexModes.get(change.path) === true,
    );
    if (!candidate) {
      continue;
    }
    checked++;
    const lines = countLines(candidate.content, candidate.style);
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
    process.stderr.write("counted-lines\tlimit\tkind\tpath\n");
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
