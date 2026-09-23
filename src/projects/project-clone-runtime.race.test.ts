import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runner = vi.hoisted(() => ({ run: vi.fn(), register: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runner.run }));
vi.mock("../state/openclaw-state-lease.js", () => ({
  withOpenClawStateLease: async (
    _options: unknown,
    fn: (lease: { signal: AbortSignal; assertOwned: () => void }) => Promise<unknown>,
  ) => fn({ signal: new AbortController().signal, assertOwned: () => {} }),
}));
vi.mock("./project-registry.js", () => ({
  listProjectRegistry: () => [],
  registerClonedProjectRegistry: runner.register,
  removeProjectCheckoutReference: vi.fn(),
  withProjectCheckoutLifecycle: vi.fn(),
}));
import { cloneProjectCheckout } from "./project-clone-runtime.js";
import { materializeProjectClone } from "./project-clone.js";

let root: string;
let target: string;
const ok = { code: 0, termination: "exit", stderr: "", stdout: "" };
const fail = { code: 1, termination: "exit", stderr: "clone failed", stdout: "" };
const stageFrom = (argv: string[]) => argv[5];

async function stages(): Promise<string[]> {
  return (await fs.readdir(path.dirname(target))).filter((entry) => entry.includes(".clone-"));
}
async function failure(promise: Promise<void>, cause: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ failure: cause });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "project-clone-race-"));
  target = path.join(root, "managed", "checkout");
  runner.run.mockReset();
  runner.register.mockReset();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("project clone target ownership", () => {
  it("CLONE-01 preserves a raced-in nonempty target on Git failure", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "foreign"), "sentinel");
      await fs.writeFile(path.join(stageFrom(argv), "partial"), "owned");
      return fail;
    });
    await failure(cloneProjectCheckout({ url: "fixture", target }), "clone_failed");
    expect(await fs.readFile(path.join(target, "foreign"), "utf8")).toBe("sentinel");
    expect(await stages()).toEqual([]);
  });

  it("CLONE-02 does not overwrite a raced-in empty target", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.mkdir(target);
      await fs.writeFile(path.join(stageFrom(argv), "owned"), "content");
      return ok;
    });
    await failure(cloneProjectCheckout({ url: "fixture", target }), "target_exists");
    expect(await fs.readdir(target)).toEqual([]);
    expect(await stages()).toEqual([]);
  });

  it("CLONE-03 cleans an owned stage after command failure", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "partial"), "owned");
      return fail;
    });
    await failure(cloneProjectCheckout({ url: "fixture", target }), "clone_failed");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stages()).toEqual([]);
  });

  it("CLONE-04 cleans an owned stage after timeout", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "partial"), "owned");
      return { ...fail, termination: "timeout" };
    });
    await failure(cloneProjectCheckout({ url: "fixture", target }), "network");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stages()).toEqual([]);
  });

  it("CLONE-05 publishes a successful staged checkout", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.mkdir(path.join(stageFrom(argv), ".git"));
      await fs.writeFile(path.join(stageFrom(argv), "README.md"), "checkout");
      return ok;
    });
    await cloneProjectCheckout({ url: "fixture", target });
    expect(await fs.readFile(path.join(target, "README.md"), "utf8")).toBe("checkout");
    expect((await fs.stat(path.join(target, ".git"))).isDirectory()).toBe(true);
    expect(await stages()).toEqual([]);
  });

  it("CLONE-06 rejects an entry-time existing target without invoking Git", async () => {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "foreign"), "sentinel");
    await failure(cloneProjectCheckout({ url: "fixture", target }), "target_exists");
    expect(runner.run).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(target, "foreign"), "utf8")).toBe("sentinel");
  });

  it("CLONE-07 lets exactly one simultaneous clone reserve the target", async () => {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "owner"), "checkout");
      arrivals++;
      if (arrivals === 2) {
        release();
      }
      await gate;
      return ok;
    });
    const results = await Promise.allSettled([
      cloneProjectCheckout({ url: "fixture", target }),
      cloneProjectCheckout({ url: "fixture", target }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ failure: "target_exists" });
    expect(await fs.readFile(path.join(target, "owner"), "utf8")).toBe("checkout");
    expect(await stages()).toEqual([]);
  });

  it("CLONE-08 cleans only its stage when command aborts", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "partial"), "owned");
      throw new Error("aborted");
    });
    await expect(cloneProjectCheckout({ url: "fixture", target })).rejects.toThrow("aborted");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stages()).toEqual([]);
  });

  it("CLONE-09 preserves a foreign target created after successful staging", async () => {
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "owned"), "checkout");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "foreign"), "sentinel");
      return ok;
    });
    await failure(cloneProjectCheckout({ url: "fixture", target }), "target_exists");
    expect(await fs.readFile(path.join(target, "foreign"), "utf8")).toBe("sentinel");
    await expect(fs.lstat(path.join(target, "owned"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stages()).toEqual([]);
  });

  it("CLONE-10 preserves a raced-in replacement after registration failure", async () => {
    const sibling = path.join(root, "sibling");
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, "sentinel"), "unchanged");
    runner.run.mockImplementation(async (argv: string[]) => {
      await fs.writeFile(path.join(stageFrom(argv), "owned"), "checkout");
      return ok;
    });
    let checkout = "";
    runner.register.mockImplementation(async (input: { path: string }) => {
      checkout = input.path;
      await fs.rm(checkout, { recursive: true });
      await fs.mkdir(checkout);
      await fs.writeFile(path.join(checkout, "foreign"), "sentinel");
      throw new Error("registration failed");
    });
    await expect(
      materializeProjectClone(
        { cfg: {} as OpenClawConfig, gitUrl: "https://github.com/acme/fixture.git" },
        { env: { ...process.env, OPENCLAW_STATE_DIR: root } },
      ),
    ).rejects.toThrow("registration failed");
    expect(await fs.readFile(path.join(checkout, "foreign"), "utf8")).toBe("sentinel");
    expect(await fs.readFile(path.join(sibling, "sentinel"), "utf8")).toBe("unchanged");
  });
});
