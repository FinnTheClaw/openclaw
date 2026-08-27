import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

function check(cwd: string): Result {
  return run(
    process.execPath,
    ["--import", tsxLoader, join(cwd, "scripts/check-source-size.ts")],
    cwd,
  );
}

function codeLines(
  count: number,
  makeLine = (index: number) => `const value${index} = ${index};`,
): string {
  return Array.from({ length: count }, (_, index) => makeLine(index)).join("\n");
}

async function writeBaseline(cwd: string, baseCommit: string, extra: object = {}): Promise<void> {
  await writeFile(
    join(cwd, "scripts/source-size-baseline.json"),
    `${JSON.stringify({ schemaVersion: 1, baseCommit, ...extra }, null, 2)}\n`,
    "utf8",
  );
}

async function expectNewFailure(
  cwd: string,
  filePath: string,
  content: string,
  pattern: RegExp,
): Promise<void> {
  await writeFile(join(cwd, filePath), content, "utf8");
  const result = check(cwd);
  assert.equal(result.code, 1, `${filePath} should fail`);
  assert.match(result.output, pattern);
  await rm(join(cwd, filePath));
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "openclaw-source-size-"));
  try {
    assert.equal(git(["init", "-q"], cwd).code, 0);
    assert.equal(git(["config", "user.email", "test@example.invalid"], cwd).code, 0);
    assert.equal(git(["config", "user.name", "Source Size Test"], cwd).code, 0);
    await mkdir(join(cwd, "scripts"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, ".gitignore"), "src/ignored.ts\n", "utf8");
    await writeFile(join(cwd, "legacy.ts"), codeLines(501), "utf8");
    assert.equal(git(["add", ".gitignore", "legacy.ts"], cwd).code, 0);
    assert.equal(git(["commit", "-qm", "baseline"], cwd).code, 0);
    const baseCommit = run("git", ["rev-parse", "HEAD"], cwd).output.trim();
    const checkerSource = await readFile(checker, "utf8");
    await writeFile(
      join(cwd, "scripts/check-source-size.ts"),
      checkerSource.replace("e9030d5476e5572a44ba89f653bc5c6c428ea351", baseCommit),
      "utf8",
    );
    await writeBaseline(cwd, baseCommit);
    assert.equal(check(cwd).code, 0);

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

    await expectNewFailure(cwd, "copy.ts", codeLines(501), /501\t500\tnew\tcopy\.ts/u);
    await expectNewFailure(
      cwd,
      "src/untracked.ts",
      codeLines(501),
      /501\t500\tnew\tsrc\/untracked\.ts/u,
    );
    await expectNewFailure(
      cwd,
      "src/ignored.ts",
      codeLines(501),
      /501\t500\tnew\tsrc\/ignored\.ts/u,
    );

    const quoted = codeLines(501, (index) => `const value${index} = "/* //";`);
    await expectNewFailure(cwd, "src/quoted.ts", quoted, /501\t500\tnew\tsrc\/quoted\.ts/u);
    const template = ["const value = `", ...Array<string>(499).fill("/* //"), "`;"].join("\n");
    await expectNewFailure(cwd, "src/template.ts", template, /501\t500\tnew\tsrc\/template\.ts/u);
    const rustRaw = [
      'const VALUE: &str = r###"',
      ...Array<string>(499).fill("/* //"),
      '"###;',
    ].join("\n");
    await expectNewFailure(cwd, "src/raw.rs", rustRaw, /501\t500\tnew\tsrc\/raw\.rs/u);
    const rustChar = codeLines(501, () => "let slash: char = '/';");
    await expectNewFailure(cwd, "src/char.rs", rustChar, /501\t500\tnew\tsrc\/char\.rs/u);
    const pythonRaw = codeLines(501, (index) => `value${index} = r"# /* //"`);
    await expectNewFailure(cwd, "src/raw.py", pythonRaw, /501\t500\tnew\tsrc\/raw\.py/u);

    const comments = `${codeLines(500, (index) => `const value${index} = "/* //";`)}\n${Array<string>(100).fill("// ignored").join("\n")}`;
    await writeFile(join(cwd, "src/comments.ts"), comments, "utf8");
    assert.equal(
      check(cwd).code,
      0,
      "comment-only lines are excluded without hiding string content",
    );
    await rm(join(cwd, "src/comments.ts"));

    const executable = codeLines(501, (index) => `command_${index}`);
    await writeFile(join(cwd, "scripts/executable"), executable, "utf8");
    await chmod(join(cwd, "scripts/executable"), 0o755);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /501\t500\tnew\tscripts\/executable/u);
    await rm(join(cwd, "scripts/executable"));
    const shell = `#!/bin/sh\n${codeLines(500, () => "printf '%s\\n' '# /* //' ")}`;
    await expectNewFailure(cwd, "scripts/shebang", shell, /501\t500\tnew\tscripts\/shebang/u);

    for (let index = 0; index < 128; index++) {
      await writeFile(
        join(cwd, `src/small-${index}.rs`),
        `// ignored\nlet value_${index} = ${index};\n`,
        "utf8",
      );
    }
    assert.equal(check(cwd).code, 0, "large changed-file populations use bounded sequential reads");
    for (let index = 0; index < 128; index++) {
      await rm(join(cwd, `src/small-${index}.rs`));
    }

    await symlink("../renamed.ts", join(cwd, "src/link.ts"));
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /governed path must be a regular file: src\/link\.ts/u);
    await rm(join(cwd, "src/link.ts"));

    await writeFile(join(cwd, "src/bad\n.ts"), "const value = 1;\n", "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /malformed repository path/u);
    await rm(join(cwd, "src/bad\n.ts"));

    await writeBaseline(cwd, baseCommit, { legacyMaxNonCommentLines: { "legacy.ts": 9999 } });
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /may contain only baseCommit and schemaVersion/u);
    await writeBaseline(cwd, "0".repeat(40));
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /must match the immutable source-GO skeleton/u);
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
