import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Result = { code: number; output: string };

const checker = fileURLToPath(new URL("./check-source-size.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

function run(command: string, args: string[], cwd: string): Result {
  try {
    return {
      code: 0,
      output: execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer; stdout?: Buffer };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
    };
  }
}

function git(args: string[], cwd: string): Result {
  return run("git", args, cwd);
}

function codeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n");
}

function check(cwd: string, ...args: string[]): Result {
  return run(
    process.execPath,
    ["--import", tsxLoader, join(cwd, "scripts/check-source-size.ts"), ...args],
    cwd,
  );
}

async function writeBaseline(cwd: string, baseCommit: string): Promise<void> {
  await writeFile(
    join(cwd, "scripts/source-size-baseline.json"),
    `${JSON.stringify({ schemaVersion: 1, baseCommit, legacyMaxNonCommentLines: {} }, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "openclaw-source-size-"));
  try {
    assert.equal(git(["init", "-q"], cwd).code, 0);
    assert.equal(git(["config", "user.email", "test@example.invalid"], cwd).code, 0);
    assert.equal(git(["config", "user.name", "Source Size Test"], cwd).code, 0);
    await mkdir(join(cwd, "scripts"));
    await cp(checker, join(cwd, "scripts/check-source-size.ts"));
    await writeFile(join(cwd, "legacy.ts"), codeLines(501), "utf8");
    assert.equal(git(["add", "legacy.ts"], cwd).code, 0);
    assert.equal(git(["commit", "-qm", "baseline"], cwd).code, 0);
    const baseCommit = run("git", ["rev-parse", "HEAD"], cwd).output.trim();
    await writeBaseline(cwd, baseCommit);
    assert.equal(check(cwd, "--refresh-legacy-baseline").code, 0);

    assert.equal(check(cwd).code, 0, "unchanged legacy file is accepted");
    await writeFile(join(cwd, "legacy.ts"), codeLines(502), "utf8");
    let result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /502\t501\texisting\tlegacy\.ts/u);

    await writeFile(join(cwd, "legacy.ts"), codeLines(500), "utf8");
    await rename(join(cwd, "legacy.ts"), join(cwd, "renamed.ts"));
    await writeFile(join(cwd, "renamed.ts"), codeLines(502), "utf8");
    assert.equal(git(["add", "-A", "legacy.ts", "renamed.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /502\t501\texisting\trenamed\.ts/u);

    await writeFile(join(cwd, "renamed.ts"), codeLines(500), "utf8");
    await writeFile(join(cwd, "copy.ts"), codeLines(501), "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /501\t500\tnew\tcopy\.ts/u);
    await rm(join(cwd, "copy.ts"));

    await writeFile(
      join(cwd, "comments.ts"),
      `${codeLines(500)}\n// ignored\n/* ignored */\n\n`,
      "utf8",
    );
    for (let index = 0; index < 128; index++) {
      await writeFile(
        join(cwd, `small-${index}.rs`),
        `// ignored\nlet value_${index} = ${index};\n`,
        "utf8",
      );
    }
    assert.equal(check(cwd).code, 0, "comments and many files are processed with bounded reads");

    await writeBaseline(cwd, "HEAD");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /full lowercase commit SHA/u);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
