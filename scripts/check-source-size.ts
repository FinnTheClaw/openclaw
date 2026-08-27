import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const MAX_NEW_FILE_LINES = 500;
const BASELINE_PATH = "scripts/source-size-baseline.json";
const GOVERNED_EXTENSIONS = new Set([
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
const HASH_COMMENT_EXTENSIONS = new Set([".pl", ".ps1", ".py", ".rb", ".sh"]);

type Baseline = {
  baseCommit: string;
  legacyMaxNonCommentLines: Record<string, number>;
  schemaVersion: 1;
};

type Change = {
  baselinePath?: string;
  kind: "existing" | "new";
  path: string;
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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

function isGovernedPath(filePath: string): boolean {
  return GOVERNED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function parseBaseline(value: unknown): Baseline {
  if (!value || typeof value !== "object") {
    throw new Error("source-size baseline must be an object");
  }
  const candidate = value as Partial<Baseline>;
  if (candidate.schemaVersion !== 1) {
    throw new Error("source-size baseline schemaVersion must be 1");
  }
  if (typeof candidate.baseCommit !== "string" || !/^[0-9a-f]{40}$/u.test(candidate.baseCommit)) {
    throw new Error("source-size baseline baseCommit must be a full lowercase commit SHA");
  }
  if (
    !candidate.legacyMaxNonCommentLines ||
    typeof candidate.legacyMaxNonCommentLines !== "object"
  ) {
    throw new Error("source-size baseline legacyMaxNonCommentLines must be an object");
  }
  for (const [filePath, count] of Object.entries(candidate.legacyMaxNonCommentLines)) {
    if (!isGovernedPath(filePath) || !Number.isSafeInteger(count) || count <= MAX_NEW_FILE_LINES) {
      throw new Error(`invalid legacy source-size baseline entry: ${filePath}`);
    }
  }
  return candidate as Baseline;
}

async function loadBaseline(root: string): Promise<Baseline> {
  const baselinePath = join(root, BASELINE_PATH);
  return parseBaseline(JSON.parse(await readFile(baselinePath, "utf8")) as unknown);
}

function assertImmutableBase(root: string, baseCommit: string): void {
  const resolved = git(["rev-parse", `${baseCommit}^{commit}`], root).trim();
  if (resolved !== baseCommit) {
    throw new Error("source-size baseline baseCommit did not resolve exactly");
  }
  if (gitExitCode(["merge-base", "--is-ancestor", baseCommit, "HEAD"], root) !== 0) {
    throw new Error("source-size baseline baseCommit must be an ancestor of HEAD");
  }
}

function parseNameStatus(raw: string): Change[] {
  const tokens = raw.split("\0");
  const changes = new Map<string, Change>();
  for (let index = 0; index < tokens.length - 1; ) {
    const status = tokens[index++];
    if (!status) {
      continue;
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (code === "R") {
        changes.set(newPath, { baselinePath: oldPath, kind: "existing", path: newPath });
      } else {
        changes.set(newPath, { kind: "new", path: newPath });
      }
      continue;
    }
    const filePath = tokens[index++];
    if (code !== "D") {
      changes.set(filePath, { kind: code === "A" ? "new" : "existing", path: filePath });
    }
  }
  return [...changes.values()];
}

function collectChanges(root: string, baseCommit: string): Change[] {
  // Do not ask Git to find copies: a copied source file is a new file and gets the 500-line cap.
  const changes = parseNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"], root),
  );
  const seen = new Set(changes.map((change) => change.path));
  for (const filePath of git(["ls-files", "--others", "--exclude-standard", "-z"], root).split(
    "\0",
  )) {
    if (filePath && !seen.has(filePath)) {
      changes.push({ kind: "new", path: filePath });
    }
  }
  return changes.filter((change) => isGovernedPath(change.path));
}

function countNonCommentLines(content: string, extension: string): number {
  let inBlockComment = false;
  let count = 0;
  for (const originalLine of content.split(/\r?\n/u)) {
    let line = originalLine.trimStart();
    while (line) {
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end === -1) {
          break;
        }
        inBlockComment = false;
        line = line.slice(end + 2).trimStart();
        continue;
      }
      if (
        line.startsWith("//") ||
        (HASH_COMMENT_EXTENSIONS.has(extension) && line.startsWith("#") && !line.startsWith("#!"))
      ) {
        break;
      }
      const blockStart = line.indexOf("/*");
      if (blockStart === 0) {
        inBlockComment = true;
        line = line.slice(2);
        continue;
      }
      count++;
      if (blockStart > 0 && line.indexOf("*/", blockStart + 2) === -1) {
        inBlockComment = true;
      }
      break;
    }
  }
  return count;
}

async function countFile(root: string, filePath: string): Promise<number> {
  return countNonCommentLines(
    await readFile(join(root, filePath), "utf8"),
    extname(filePath).toLowerCase(),
  );
}

async function refreshLegacyBaseline(root: string, baseline: Baseline): Promise<void> {
  if (gitExitCode(["diff", "--quiet", baseline.baseCommit, "--"], root) !== 0) {
    throw new Error("refresh requires tracked source to match the immutable base commit");
  }
  const entries: Record<string, number> = {};
  const paths = git(["ls-tree", "-r", "-z", "--name-only", baseline.baseCommit], root).split("\0");
  // Sequential reads intentionally bound descriptors for very large repositories.
  for (const filePath of paths) {
    if (filePath && isGovernedPath(filePath) && existsSync(join(root, filePath))) {
      const count = await countFile(root, filePath);
      if (count > MAX_NEW_FILE_LINES) {
        entries[filePath] = count;
      }
    }
  }
  baseline.legacyMaxNonCommentLines = Object.fromEntries(
    Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

async function check(root: string, baseline: Baseline): Promise<number> {
  const failures: string[] = [];
  let checked = 0;
  // Sequential reads intentionally bound descriptors for very large repositories.
  for (const change of collectChanges(root, baseline.baseCommit).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    if (!existsSync(join(root, change.path))) {
      continue;
    }
    checked++;
    const lines = await countFile(root, change.path);
    const baselinePath = change.baselinePath ?? change.path;
    const limit =
      change.kind === "existing"
        ? (baseline.legacyMaxNonCommentLines[baselinePath] ?? MAX_NEW_FILE_LINES)
        : MAX_NEW_FILE_LINES;
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
  const refresh = process.argv.slice(2).join(" ") === "--refresh-legacy-baseline";
  if (!refresh && process.argv.length > 2) {
    throw new Error("usage: check-source-size.ts [--refresh-legacy-baseline]");
  }
  const root = repositoryRoot();
  const baseline = await loadBaseline(root);
  assertImmutableBase(root, baseline.baseCommit);
  if (refresh) {
    await refreshLegacyBaseline(root, baseline);
    return 0;
  }
  return check(root, baseline);
}

void main().then(
  (exitCode) => process.exit(exitCode),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
