import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

describe("sync-labels", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === "git") {
        return "https://github.com/openclaw/openclaw.git\n";
      }
      if (command === "gh" && args?.some((arg) => arg.includes("/labels?"))) {
        return "[]";
      }
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["multiple pages", "single page", "empty inventory"] as const)(
    "flattens paginated existing label inventories (%s)",
    async (inventory) => {
      const config = parse(readFileSync(resolve(".github/labeler.yml"), "utf8")) as Record<
        string,
        unknown
      >;
      const desired = [
        ...new Set([
          ...Object.keys(config),
          "size: XS",
          "size: S",
          "size: M",
          "size: L",
          "size: XL",
          "beta-blocker",
        ]),
      ];
      const known = [
        { name: "plugin: azure-speech" },
        { name: "beta-blocker" },
        { name: "synthetic-unconfigured-label" },
      ];
      const pages =
        inventory === "multiple pages"
          ? [[known[0]], known.slice(1)]
          : inventory === "single page"
            ? [known]
            : [[]];
      const existing = new Set(pages.flat().map((label) => label.name));
      const missing = desired.filter((name) => !existing.has(name));
      // Every fixture leaves configured labels missing, avoiding the script's process.exit branch.
      expect(missing.length).toBeGreaterThan(0);
      execFileSyncMock.mockImplementation((command: string, args?: readonly string[]) => {
        if (command === "git") {
          expect(args).toEqual(["config", "--get", "remote.origin.url"]);
          return "https://github.com/openclaw/openclaw.git\n";
        }
        if (command === "gh" && args?.some((arg) => arg.includes("/labels?"))) {
          expect(args).toContain("--paginate");
          return args.includes("--slurp")
            ? JSON.stringify(pages)
            : pages.map((page) => JSON.stringify(page)).join("\n");
        }
        if (command === "gh" && args?.[0] === "api" && args[1] === "-X" && args[2] === "POST") {
          expect(args[3]).toBe("repos/openclaw/openclaw/labels");
          return "";
        }
        throw new Error(`Unexpected synthetic label command: ${JSON.stringify({ command, args })}`);
      });

      await expect(import("../../scripts/sync-labels.ts")).resolves.toBeDefined();

      const ghCalls = execFileSyncMock.mock.calls.filter(([command]) => command === "gh");
      const creates = ghCalls.filter(([, args]) => args.includes("POST"));
      const createdNames = creates.map(([, args]) =>
        args.find((arg: string) => arg.startsWith("name="))?.slice("name=".length),
      );
      expect(createdNames.toSorted()).toEqual(missing.toSorted());
      expect(new Set(createdNames).size).toBe(createdNames.length);
      for (const name of existing) {
        expect(createdNames).not.toContain(name);
      }
      const beta = creates.find(([, args]) => args.includes("name=beta-blocker"));
      if (existing.has("beta-blocker")) {
        expect(beta).toBeUndefined();
      } else {
        expect(beta?.[1]).toEqual([
          "api",
          "-X",
          "POST",
          "repos/openclaw/openclaw/labels",
          "-f",
          "name=beta-blocker",
          "-f",
          "color=D93F0B",
          "-f",
          "description=Plugin beta-release blocker pending stable cutoff triage",
        ]);
      }
      for (const call of ghCalls) {
        expect(call[2]).toMatchObject({ timeout: 120_000, killSignal: "SIGKILL" });
      }
    },
  );

  it("bounds every GitHub CLI operation", async () => {
    await import("../../scripts/sync-labels.ts");

    const ghCalls = execFileSyncMock.mock.calls.filter(([command]) => command === "gh");
    expect(ghCalls.length).toBeGreaterThan(1);
    for (const call of ghCalls) {
      const options = call[2];
      expect(options).toMatchObject({
        timeout: 120_000,
        killSignal: "SIGKILL",
      });
    }
  });
});
