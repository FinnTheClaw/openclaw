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
    for (const directory of [
      "scripts",
      "src",
      "docs",
      "custom/deep",
      "vendor",
      ".github/actions",
      "git-hooks",
      "node_modules/dependency",
    ]) {
      await mkdir(join(cwd, directory), { recursive: true });
    }
    assert.equal(git(["init", "-q"], cwd).code, 0);
    assert.equal(git(["config", "user.email", "test@example.invalid"], cwd).code, 0);
    assert.equal(git(["config", "user.name", "Source Size Test"], cwd).code, 0);
    await writeFile(join(cwd, ".gitignore"), "src/ignored.ts\nnode_modules/\n", "utf8");
    await writeFile(join(cwd, "legacy.ts"), codeLines(501), "utf8");
    await writeFile(join(cwd, "docs/legacy.ts"), codeLines(501), "utf8");
    await writeFile(join(cwd, "rename-data.txt"), codeLines(5000), "utf8");
    await writeFile(join(cwd, "chmod-data.txt"), codeLines(5000), "utf8");
    assert.equal(
      git(
        ["add", ".gitignore", "legacy.ts", "docs/legacy.ts", "rename-data.txt", "chmod-data.txt"],
        cwd,
      ).code,
      0,
    );
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

    await rename(join(cwd, "docs/legacy.ts"), join(cwd, "docs/renamed.ts"));
    await writeFile(join(cwd, "docs/renamed.ts"), codeLines(502), "utf8");
    assert.equal(git(["add", "-A", "docs/legacy.ts", "docs/renamed.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /502\t501\texisting\tdocs\/renamed\.ts/u);
    await writeFile(join(cwd, "docs/renamed.ts"), codeLines(500), "utf8");

    await rename(join(cwd, "rename-data.txt"), join(cwd, "feature.ts"));
    assert.equal(git(["add", "-A", "rename-data.txt", "feature.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /5000\t500\texisting\tfeature\.ts/u);
    await writeFile(join(cwd, "feature.ts"), codeLines(500), "utf8");

    await chmod(join(cwd, "chmod-data.txt"), 0o644);
    assert.equal(git(["update-index", "--chmod=+x", "chmod-data.txt"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /5000\t500\texisting\tchmod-data\.txt/u);
    await writeFile(join(cwd, "chmod-data.txt"), codeLines(500), "utf8");

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
    await expectNewFailure(
      cwd,
      "custom/deep/source.ts",
      codeLines(501),
      /custom\/deep\/source\.ts/u,
    );
    await expectNewFailure(cwd, "vendor/source.ts", codeLines(501), /vendor\/source\.ts/u);
    await expectNewFailure(
      cwd,
      ".github/actions/source.ts",
      codeLines(501),
      /.github\/actions\/source\.ts/u,
    );

    for (const extension of ["bash", "zsh", "fish", "swift"]) {
      await expectNewFailure(
        cwd,
        `custom/deep/source.${extension}`,
        codeLines(501, () => "rm -rf /*"),
        new RegExp(`501\\t500\\tnew\\tcustom/deep/source\\.${extension}`, "u"),
      );
    }

    const regexLines = codeLines(501, () => "const matcher = /[/*]/;");
    await expectNewFailure(cwd, "custom/deep/regex.ts", regexLines, /custom\/deep\/regex\.ts/u);
    const stringLines = codeLines(501, () => 'const marker = "/*";');
    await expectNewFailure(cwd, "custom/deep/string.ts", stringLines, /custom\/deep\/string\.ts/u);
    const pureBlock = ["/*", ...Array<string>(499).fill("* body"), "*/"].join("\n");
    await writeFile(join(cwd, "custom/deep/pure-block.ts"), pureBlock, "utf8");
    assert.equal(check(cwd).code, 0, "a 501-line pure whole-line block comment is excluded");
    await rm(join(cwd, "custom/deep/pure-block.ts"));
    const trailingCode = `${codeLines(500)}\n/*\nbody\n*/ const extra = 1;`;
    await expectNewFailure(
      cwd,
      "custom/deep/trailing.ts",
      trailingCode,
      /501\t500\tnew\tcustom\/deep\/trailing\.ts/u,
    );
    const inlineBlock = codeLines(501, (index) => `const value${index} = ${index}; /*`);
    await expectNewFailure(
      cwd,
      "custom/deep/inline.ts",
      inlineBlock,
      /501\t500\tnew\tcustom\/deep\/inline\.ts/u,
    );
    const nestedRust = `${codeLines(499, (index) => `let value_${index} = ${index};`)}\n/*\n/* nested\n*/\n*/`;
    await expectNewFailure(
      cwd,
      "custom/deep/nested.rs",
      nestedRust,
      /501\t500\tnew\tcustom\/deep\/nested\.rs/u,
    );

    const comments = `${codeLines(500)}\n${Array<string>(100).fill("// comment").join("\n")}`;
    await writeFile(join(cwd, "custom/deep/comments.ts"), comments, "utf8");
    assert.equal(check(cwd).code, 0, "only unambiguous whole-line comments are excluded");
    await rm(join(cwd, "custom/deep/comments.ts"));

    const shell = `#!/bin/sh\n${codeLines(500, () => "rm -rf /*")}`;
    await expectNewFailure(cwd, "custom/deep/tool.conf", shell, /custom\/deep\/tool\.conf/u);
    await writeFile(join(cwd, "git-hooks/hook"), codeLines(501), "utf8");
    await chmod(join(cwd, "git-hooks/hook"), 0o755);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /git-hooks\/hook/u);
    await rm(join(cwd, "git-hooks/hook"));
    await writeFile(join(cwd, "custom/deep/executable.txt"), codeLines(501), "utf8");
    await chmod(join(cwd, "custom/deep/executable.txt"), 0o755);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /custom\/deep\/executable\.txt/u);
    await rm(join(cwd, "custom/deep/executable.txt"));

    await writeFile(join(cwd, "node_modules/dependency/large.ts"), codeLines(501), "utf8");
    assert.equal(check(cwd).code, 0, "proven untracked dependency roots are excluded");
    await rm(join(cwd, "node_modules/dependency/large.ts"));

    await symlink("../../legacy.ts", join(cwd, "custom/deep/link.txt"));
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /changed path must be a regular file: custom\/deep\/link\.txt/u);
    await rm(join(cwd, "custom/deep/link.txt"));

    await writeFile(join(cwd, "custom/deep/bad\n.ts"), "const value = 1;\n", "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /malformed repository path/u);
    await rm(join(cwd, "custom/deep/bad\n.ts"));

    for (let index = 0; index < 128; index++) {
      await writeFile(
        join(cwd, `custom/deep/small-${index}.rs`),
        `// comment\nlet value_${index} = ${index};\n`,
        "utf8",
      );
    }
    assert.equal(check(cwd).code, 0, "large populations use bounded sequential reads");
    for (let index = 0; index < 128; index++) {
      await rm(join(cwd, `custom/deep/small-${index}.rs`));
    }

    await writeBaseline(cwd, baseCommit, { legacyMaxNonCommentLines: { "legacy.ts": 9999 } });
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /may contain only baseCommit and schemaVersion/u);
    await writeBaseline(cwd, "0".repeat(40));
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /must match the immutable source-GO skeleton/u);
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
