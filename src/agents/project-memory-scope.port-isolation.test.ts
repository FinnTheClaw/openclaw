import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { filterProjectScopedCuratedContextFiles } from "./project-memory-bootstrap.js";
import { resolveProjectKey } from "./project-memory-scope.js";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function makeRepo(remote?: string): Promise<string> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-port-"));
  const repo = await fs.realpath(temporaryRoot);
  cleanupRoots.push(repo);
  await git(repo, "init", "--quiet");
  if (remote) {
    await git(repo, "remote", "add", "origin", remote);
  }
  return repo;
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0).reverse()) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("project memory nondefault-port isolation", () => {
  it("CP60-MEM01 keeps HTTPS repositories on different nondefault ports isolated", async () => {
    const https8443 = await makeRepo("https://git.example:8443/team/repo.git");
    const https9443 = await makeRepo("https://git.example:9443/team/repo.git");

    const keys = await Promise.all([resolveProjectKey(https8443), resolveProjectKey(https9443)]);

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("CP60-MEM02 keeps SSH repositories on different nondefault ports isolated", async () => {
    const ssh2222 = await makeRepo("ssh://git@git.example:2222/team/repo.git");
    const ssh2223 = await makeRepo("ssh://git@git.example:2223/team/repo.git");

    const keys = await Promise.all([resolveProjectKey(ssh2222), resolveProjectKey(ssh2223)]);

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("CP60-MEM03 keeps distinct repository paths isolated on the same nondefault port", async () => {
    const alpha = await makeRepo("https://git.example:8443/team/alpha.git");
    const beta = await makeRepo("https://git.example:8443/team/beta.git");

    const keys = await Promise.all([resolveProjectKey(alpha), resolveProjectKey(beta)]);

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("CP60-MEM04 converges implicit and explicit default HTTPS port origins", async () => {
    const implicit443 = await makeRepo("https://git.example/team/repo.git");
    const explicit443 = await makeRepo("https://git.example:443/team/repo.git");

    await expect(
      Promise.all([resolveProjectKey(implicit443), resolveProjectKey(explicit443)]),
    ).resolves.toEqual(["git.example/team/repo", "git.example/team/repo"]);
  });

  it("CP60-MEM05 converges default-port SSH URL and SCP-style origins", async () => {
    const sshUrl = await makeRepo("ssh://git@git.example:22/team/repo.git");
    const scpUrl = await makeRepo("git@git.example:team/repo.git");

    await expect(
      Promise.all([resolveProjectKey(sshUrl), resolveProjectKey(scpUrl)]),
    ).resolves.toEqual(["git.example/team/repo", "git.example/team/repo"]);
  });

  it("CP60-MEM06 folds userinfo for otherwise identical remote endpoints", async () => {
    const alice = await makeRepo("https://alice:one@git.example:8443/team/repo.git");
    const bob = await makeRepo("https://bob:two@git.example:8443/team/repo.git");

    const keys = await Promise.all([resolveProjectKey(alice), resolveProjectKey(bob)]);

    expect(keys[0]).toBe(keys[1]);
  });

  it("CP60-MEM07 preserves case-sensitive remote path identity", async () => {
    const upper = await makeRepo("ssh://git@git.example:2222/team/Repo.git");
    const lower = await makeRepo("ssh://git@git.example:2222/team/repo.git");

    const keys = await Promise.all([resolveProjectKey(upper), resolveProjectKey(lower)]);

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("CP60-MEM08 converges a linked worktree with its source repository", async () => {
    const repo = await makeRepo("https://git.example:8443/team/repo.git");
    await git(repo, "config", "user.email", "project-memory-test@example.invalid");
    await git(repo, "config", "user.name", "Project Memory Test");
    await fs.writeFile(path.join(repo, "README.md"), "temporary repository\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "--quiet", "-m", "temporary repository");
    const worktreePath = `${repo}-worktree`;
    cleanupRoots.push(worktreePath);
    await git(repo, "worktree", "add", "--quiet", "-b", "project-memory-test", worktreePath);
    const worktree = await fs.realpath(worktreePath);

    const keys = await Promise.all([resolveProjectKey(repo), resolveProjectKey(worktree)]);

    expect(keys[0]).toBe(keys[1]);
  });

  it("CP60-MEM09 uses the canonical absolute path when origin is absent", async () => {
    const repo = await makeRepo();

    await expect(resolveProjectKey(repo)).resolves.toBe(`path:${path.resolve(repo)}`);
  });

  it("CP60-MEM10 filters curated context using the distinct resolved HTTPS-port identities", async () => {
    const https8443 = await makeRepo("https://git.example:8443/team/repo.git");
    const https9443 = await makeRepo("https://git.example:9443/team/repo.git");
    const [key8443, key9443] = await Promise.all([
      resolveProjectKey(https8443),
      resolveProjectKey(https9443),
    ]);
    const contextFiles = [
      {
        path: "MEMORY.md",
        content: [
          `- Port 8443 fact. <!-- project: ${key8443} -->`,
          `- Port 9443 fact. <!-- project: ${key9443} -->`,
        ].join("\n"),
      },
    ];

    expect(key8443).not.toBe(key9443);
    const filtered = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: [key8443],
    });

    expect(filtered[0]?.content).toContain("Port 8443 fact.");
    expect(filtered[0]?.content).not.toContain("Port 9443 fact.");
  });
});
