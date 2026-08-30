import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

function lines(
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
  assert.equal(result.code, 1, `${filePath} should exceed the nonblank limit`);
  assert.match(result.output, pattern);
  await rm(join(cwd, filePath));
}

async function removeStaged(cwd: string, filePath: string): Promise<void> {
  assert.equal(git(["rm", "--cached", "-fq", "--", filePath], cwd).code, 0);
  await rm(join(cwd, filePath), { force: true });
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "openclaw-source-size-"));
  try {
    for (const directory of ["scripts", "src", "custom", "vendor", "node_modules/dependency"]) {
      await mkdir(join(cwd, directory), { recursive: true });
    }
    assert.equal(git(["init", "-q"], cwd).code, 0);
    assert.equal(git(["config", "user.email", "test@example.invalid"], cwd).code, 0);
    assert.equal(git(["config", "user.name", "Source Size Test"], cwd).code, 0);
    await writeFile(join(cwd, ".gitignore"), "src/ignored.ts\nnode_modules/\n", "utf8");
    await mkdir(join(cwd, "src/security"), { recursive: true });
    await writeFile(join(cwd, "legacy.ts"), lines(501), "utf8");
    await writeFile(join(cwd, "rename-data.txt"), lines(5000), "utf8");
    await writeFile(join(cwd, "chmod-data.txt"), lines(5000), "utf8");
    await writeFile(join(cwd, "delete-recreate.ts"), lines(501), "utf8");
    await writeFile(join(cwd, "exploit-index-new.ts"), lines(501), "utf8");
    await writeFile(join(cwd, "exploit-worktree-new.ts"), lines(501), "utf8");
    await writeFile(
      join(cwd, "src/security/governor-host-delivery-build-manifest.generated.ts"),
      lines(17_675),
      "utf8",
    );
    assert.equal(
      git(
        [
          "add",
          ".gitignore",
          "legacy.ts",
          "rename-data.txt",
          "chmod-data.txt",
          "delete-recreate.ts",
          "exploit-index-new.ts",
          "exploit-worktree-new.ts",
          "src/security/governor-host-delivery-build-manifest.generated.ts",
        ],
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

    const manifestPath = "src/security/governor-host-delivery-build-manifest.generated.ts";
    await writeBaseline(cwd, baseCommit, { generatedDataFileMaxLines: { [manifestPath]: 17_699 } });
    await writeFile(join(cwd, manifestPath), lines(17_699), "utf8");
    assert.equal(check(cwd).code, 0, "the exact generated-data ceiling is accepted");
    await writeFile(join(cwd, manifestPath), lines(17_700), "utf8");
    const generatedLimitFailure = check(cwd);
    assert.equal(generatedLimitFailure.code, 1);
    assert.match(
      generatedLimitFailure.output,
      /17700\t17699\texisting\tworktree\tsrc\/security\/governor-host-delivery-build-manifest\.generated\.ts/u,
    );
    await writeFile(join(cwd, manifestPath), lines(17_675), "utf8");
    await writeBaseline(cwd, baseCommit);

    await writeFile(join(cwd, "index-added.ts"), lines(501), "utf8");
    assert.equal(git(["add", "index-added.ts"], cwd).code, 0);
    await rm(join(cwd, "exploit-index-new.ts"));
    let result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /501\t500\tnew\tindex\tindex-added\.ts/u);
    assert.equal(
      git(["reset", "-q", "HEAD", "--", "exploit-index-new.ts", "index-added.ts"], cwd).code,
      0,
    );
    await writeFile(join(cwd, "exploit-index-new.ts"), lines(501), "utf8");
    await rm(join(cwd, "index-added.ts"), { force: true });

    await rename(join(cwd, "exploit-worktree-new.ts"), join(cwd, "worktree-added.ts"));
    assert.equal(git(["add", "-A", "exploit-worktree-new.ts", "worktree-added.ts"], cwd).code, 0);
    await writeFile(join(cwd, "exploit-worktree-new.ts"), lines(501), "utf8");
    await writeFile(
      join(cwd, "worktree-added.ts"),
      lines(501, (index) => `export const changed${index} = "different-${index}";`),
      "utf8",
    );
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /501\t500\tnew\tworktree\tworktree-added\.ts/u);
    assert.equal(
      git(["reset", "-q", "HEAD", "--", "exploit-worktree-new.ts", "worktree-added.ts"], cwd).code,
      0,
    );
    await rm(join(cwd, "worktree-added.ts"), { force: true });

    await writeFile(join(cwd, "legacy.ts"), lines(502), "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /502\t501\texisting\tworktree\tlegacy\.ts/u);
    await writeFile(join(cwd, "legacy.ts"), lines(500), "utf8");

    await rename(join(cwd, "rename-data.txt"), join(cwd, "feature.ts"));
    assert.equal(git(["add", "-A", "rename-data.txt", "feature.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /5000\t500\texisting\tindex\tfeature\.ts/u);
    await writeFile(join(cwd, "feature.ts"), lines(500), "utf8");
    assert.equal(git(["add", "feature.ts"], cwd).code, 0);

    assert.equal(git(["update-index", "--chmod=+x", "chmod-data.txt"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /5000\t500\texisting\tindex\tchmod-data\.txt/u);
    assert.equal(git(["update-index", "--chmod=-x", "chmod-data.txt"], cwd).code, 0);

    await writeFile(join(cwd, "custom/staged-large.ts"), lines(1000), "utf8");
    assert.equal(git(["add", "custom/staged-large.ts"], cwd).code, 0);
    await writeFile(join(cwd, "custom/staged-large.ts"), lines(500), "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /1000\t500\tnew\tindex\tcustom\/staged-large\.ts/u);
    await removeStaged(cwd, "custom/staged-large.ts");

    await writeFile(join(cwd, "custom/worktree-large.ts"), lines(500), "utf8");
    assert.equal(git(["add", "custom/worktree-large.ts"], cwd).code, 0);
    await writeFile(join(cwd, "custom/worktree-large.ts"), lines(1000), "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /1000\t500\tnew\tworktree\tcustom\/worktree-large\.ts/u);
    await removeStaged(cwd, "custom/worktree-large.ts");

    assert.equal(git(["rm", "--cached", "-q", "delete-recreate.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /501\t500\tnew\tworktree\tdelete-recreate\.ts/u);
    await writeFile(join(cwd, "delete-recreate.ts"), lines(500), "utf8");

    await expectNewFailure(cwd, "copy.ts", lines(501), /501\t500\tnew\tworktree\tcopy\.ts/u);
    await expectNewFailure(cwd, "src/ignored.ts", lines(501), /src\/ignored\.ts/u);
    await expectNewFailure(
      cwd,
      "custom/regex.ts",
      lines(501, () => "const r = /[/*]/;"),
      /custom\/regex\.ts/u,
    );
    await expectNewFailure(
      cwd,
      "custom/inline.ts",
      lines(501, () => "const x = 1; /*"),
      /custom\/inline\.ts/u,
    );
    await expectNewFailure(
      cwd,
      "custom/comments.ts",
      lines(501, () => "// comment"),
      /custom\/comments\.ts/u,
    );
    const block = ["/*", ...Array<string>(499).fill("* body"), "*/"].join("\n");
    await expectNewFailure(
      cwd,
      "custom/block.ts",
      block,
      /501\t500\tnew\tworktree\tcustom\/block\.ts/u,
    );
    const template = ["const value = `", ...Array<string>(499).fill("template text"), "`;"].join(
      "\n",
    );
    await expectNewFailure(cwd, "custom/template.ts", template, /custom\/template\.ts/u);
    const triple = ['value = """', ...Array<string>(499).fill("triple text"), '"""'].join("\n");
    await expectNewFailure(cwd, "custom/triple.py", triple, /custom\/triple\.py/u);
    const shell = `#!/bin/sh\n${lines(500, () => "rm -rf /*")}`;
    await expectNewFailure(cwd, "custom/tool.conf", shell, /custom\/tool\.conf/u);
    await expectNewFailure(
      cwd,
      "custom/bare-cr.ts",
      Array<string>(501).fill("const value = 1;").join("\r"),
      /501\t500\tnew\tworktree\tcustom\/bare-cr\.ts/u,
    );
    await expectNewFailure(
      cwd,
      "custom/crlf.ts",
      Array<string>(501).fill("const value = 1;").join("\r\n"),
      /501\t500\tnew\tworktree\tcustom\/crlf\.ts/u,
    );
    await expectNewFailure(
      cwd,
      "custom/unicode-separators.ts",
      `${Array<string>(251).fill("const value = 1;").join("\u2028")}\u2029${Array<string>(250).fill("const value = 2;").join("\u2029")}`,
      /501\t500\tnew\tworktree\tcustom\/unicode-separators\.ts/u,
    );

    for (const extension of ["bash", "zsh", "fish", "swift"]) {
      await expectNewFailure(
        cwd,
        `vendor/source.${extension}`,
        lines(501),
        new RegExp(`vendor/source\\.${extension}`, "u"),
      );
    }

    await writeFile(
      join(cwd, "custom/blank-heavy.ts"),
      `${lines(500)}${"\n\n".repeat(1000)}`,
      "utf8",
    );
    assert.equal(check(cwd).code, 0, "blank physical lines are the only excluded lines");
    await rm(join(cwd, "custom/blank-heavy.ts"));

    await writeFile(join(cwd, "node_modules/dependency/large.ts"), lines(1000), "utf8");
    assert.equal(check(cwd).code, 0, "untracked generated dependency roots remain excluded");
    await rm(join(cwd, "node_modules/dependency/large.ts"));

    await writeFile(join(cwd, "custom/target"), "target\n", "utf8");
    await symlink("target", join(cwd, "custom/index-link.ts"));
    assert.equal(git(["add", "custom/index-link.ts"], cwd).code, 0);
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /Git index path is not a regular blob: custom\/index-link\.ts mode=120000/u,
    );
    await removeStaged(cwd, "custom/index-link.ts");
    await rm(join(cwd, "custom/target"));

    await writeFile(join(cwd, "custom/invalid-utf8.ts"), Buffer.from([0xff, 0xfe]));
    assert.equal(git(["add", "custom/invalid-utf8.ts"], cwd).code, 0);
    await writeFile(join(cwd, "custom/invalid-utf8.ts"), "const value = 1;\n", "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /governed source is not valid UTF-8: custom\/invalid-utf8\.ts/u);
    await removeStaged(cwd, "custom/invalid-utf8.ts");

    await writeFile(join(cwd, "custom/bad\n.ts"), "const value = 1;\n", "utf8");
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /malformed repository path/u);
    await rm(join(cwd, "custom/bad\n.ts"));

    await writeBaseline(cwd, baseCommit, { legacyMaxNonCommentLines: { "legacy.ts": 9999 } });
    result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.output, /source-size baseline has unsupported fields/u);
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
