import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMemoryWikiMutation } from "./apply.js";
import { importChatGptConversations, rollbackChatGptImportRun } from "./chatgpt-import.js";
import { compileMemoryWikiVault } from "./compile.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { buildSourcePage } from "./source-page.test-helpers.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const securityRuntimeMock = vi.hoisted(() => ({
  failReadTextOnceFor: undefined as string | undefined,
  failReadTextAlwaysFor: undefined as string | undefined,
  readTextOnceError: new Error("transient existing-page read failure"),
  readTextError: new Error("persistent existing-page read failure"),
  readTextFailureInjected: false,
  onReadText: undefined as ((relativePath: string) => Promise<void>) | undefined,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readRegularFile: async (params: Parameters<typeof actual.readRegularFile>[0]) => {
      injectPageReadFailure(params.filePath);
      return actual.readRegularFile(params);
    },
    root: async (...args: Parameters<typeof actual.root>) => {
      const vault = await actual.root(...args);
      return new Proxy(vault, {
        get(target, prop, receiver) {
          if (prop !== "readText" && prop !== "readBytes") {
            return Reflect.get(target, prop, receiver);
          }
          return async (relativePath: string) => {
            injectPageReadFailure(relativePath);
            const value = await target[prop](relativePath);
            await securityRuntimeMock.onReadText?.(relativePath);
            return value;
          };
        },
      });
    },
  };
});

const { createTempDir, createVault } = createMemoryWikiTestHarness();

async function addNotes(pagePath: string, note: string) {
  const page = (await fs.readFile(pagePath, "utf8")).replace(
    "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
    () => `<!-- openclaw:human:start -->\n${note}\n<!-- openclaw:human:end -->`,
  );
  await fs.writeFile(pagePath, page, "utf8");
}

function injectPageReadFailure(pagePath: string) {
  const matches = (expected: string | undefined) =>
    expected === pagePath ||
    (expected !== undefined && path.isAbsolute(expected) && expected.endsWith(path.sep + pagePath));
  if (matches(securityRuntimeMock.failReadTextAlwaysFor)) {
    securityRuntimeMock.readTextFailureInjected = true;
    throw securityRuntimeMock.readTextError;
  }
  if (
    matches(securityRuntimeMock.failReadTextOnceFor) &&
    !securityRuntimeMock.readTextFailureInjected
  ) {
    securityRuntimeMock.readTextFailureInjected = true;
    throw securityRuntimeMock.readTextOnceError;
  }
}

async function createImportedFixture() {
  const suiteRoot = await createTempDir("memory-wiki-source-page-");
  const sourcePath = path.join(suiteRoot, "imported.txt");
  const pagePath = "sources/imported.md";
  const params: Parameters<typeof writeImportedSourcePage>[0] = {
    vaultRoot: suiteRoot,
    sourcePath,
    pagePath,
    syncKey: "bridge:imported",
    sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
    sourceSize: 10,
    renderFingerprint: "fp-1",
    group: "bridge",
    state: { entries: {}, version: 1 },
    buildRendered: buildSourcePage,
  };
  await fs.writeFile(sourcePath, "first body", "utf8");
  await writeImportedSourcePage(params);
  return {
    pagePath,
    absPage: path.join(suiteRoot, pagePath),
    state: params.state,
    update: async () => {
      await fs.writeFile(sourcePath, "second body changed", "utf8");
      return writeImportedSourcePage({
        ...params,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
        sourceSize: 19,
        renderFingerprint: "fp-2",
      });
    },
  };
}

async function createIngestFixture() {
  const rootDir = await createTempDir("memory-wiki-ingest-retry-");
  const inputPath = path.join(rootDir, "roadmap.txt");
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, "v1 content\n", "utf8");
  await ingestMemoryWikiSource({ config, inputPath, nowMs: Date.UTC(2026, 3, 5, 12) });
  return {
    pagePath: path.join(config.vault.path, "sources", "roadmap.md"),
    update: () => ingestMemoryWikiSource({ config, inputPath, nowMs: Date.UTC(2026, 3, 6, 12) }),
    changeSource: () => fs.writeFile(inputPath, "v2 content updated\n", "utf8"),
  };
}

async function createSynthesisFixture(initialBody: string) {
  const { rootDir, config } = await createVault({ prefix: "memory-wiki-synthesis-retry-" });
  const update = (body: string) =>
    applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Release Plan",
        body,
        sourceIds: ["source.alpha"],
      },
    });
  await update(initialBody);
  return { pagePath: path.join(rootDir, "syntheses", "release-plan.md"), update };
}

async function createChatGptImportFixture(prefix = "memory-wiki-chatgpt-retry-") {
  const { rootDir, config } = await createVault({ prefix });
  const exportDir = path.join(rootDir, "chatgpt-export");
  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(
    path.join(exportDir, "conversations.json"),
    `${JSON.stringify([
      {
        conversation_id: "12345678-1234-1234-1234-1234567890ab",
        title: "Travel preference check",
        create_time: 1_712_363_200,
        update_time: 1_712_366_800,
        current_node: "assistant-1",
        mapping: {
          root: {},
          "user-1": chatNode("root", "user", "I prefer aisle seats."),
          "assistant-1": chatNode("user-1", "assistant", "Noted."),
        },
      },
    ])}\n`,
    "utf8",
  );
  await importChatGptConversations({
    config,
    exportPath: exportDir,
    nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
  });
  const sourceFiles = (await fs.readdir(path.join(rootDir, "sources"))).filter(
    (entry) => entry !== "index.md",
  );
  expect(sourceFiles).toHaveLength(1);
  return {
    rootDir,
    config,
    exportDir,
    pagePath: path.join(
      rootDir,
      "sources",
      expectDefined(sourceFiles[0], "imported Memory Wiki source file"),
    ),
  };
}

function chatNode(parent: string, role: string, text: string) {
  return { parent, message: { author: { role }, content: { parts: [text] } } };
}

describe("memory-wiki existing-page read retry", () => {
  it.each(["opening", "closing", "both"])(
    "refuses ChatGPT re-import when handwritten Notes are missing the %s marker",
    async (missing) => {
      const { config, exportDir, pagePath } = await createChatGptImportFixture();
      let page = (await fs.readFile(pagePath, "utf8")).replace(
        "<!-- openclaw:human:end -->",
        "Keep this handwritten note.\n<!-- openclaw:human:end -->",
      );
      if (missing !== "closing") {
        page = page.replace("<!-- openclaw:human:start -->", "");
      }
      if (missing !== "opening") {
        page = page.replace("<!-- openclaw:human:end -->", "");
      }
      await fs.writeFile(pagePath, page);

      await expect(importChatGptConversations({ config, exportPath: exportDir })).rejects.toThrow(
        /human Notes are missing/,
      );
      expect(await fs.readFile(pagePath, "utf8")).toBe(page);
    },
  );

  it.each(["ingest", "source-sync", "chatgpt"] as const)(
    "refuses %s updates when existing human notes contain malformed UTF-8",
    async (kind) => {
      let pagePath: string;
      let update: () => Promise<unknown>;
      let state: Parameters<typeof writeImportedSourcePage>[0]["state"] | undefined;
      if (kind === "chatgpt") {
        const fixture = await createChatGptImportFixture();
        pagePath = fixture.pagePath;
        const exportPath = path.join(fixture.exportDir, "conversations.json");
        await fs.writeFile(
          exportPath,
          (await fs.readFile(exportPath, "utf8")).replace("Noted.", "Updated travel details."),
        );
        update = () =>
          importChatGptConversations({ config: fixture.config, exportPath: fixture.exportDir });
      } else if (kind === "ingest") {
        const fixture = await createIngestFixture();
        pagePath = fixture.pagePath;
        update = async () => {
          await fixture.changeSource();
          return fixture.update();
        };
      } else {
        const fixture = await createImportedFixture();
        pagePath = fixture.absPage;
        state = fixture.state;
        update = fixture.update;
      }
      const page = await fs.readFile(pagePath, "utf8");
      const end = page.indexOf("<!-- openclaw:human:end -->");
      const malformed = Buffer.concat([
        Buffer.from(`${page.slice(0, end)}Human note: caf`),
        Buffer.from([0xe9]),
        Buffer.from(`\n${page.slice(end)}`),
      ]);
      await fs.writeFile(pagePath, malformed);
      const originalState = structuredClone(state);

      await expect(update()).rejects.toThrow(/cannot be rewritten safely/);
      expect(await fs.readFile(pagePath)).toEqual(malformed);
      if (state) {
        expect(state).toEqual(originalState);
      }
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
    securityRuntimeMock.failReadTextOnceFor = undefined;
    securityRuntimeMock.failReadTextAlwaysFor = undefined;
    securityRuntimeMock.readTextOnceError = new Error("transient existing-page read failure");
    securityRuntimeMock.readTextError = new Error("persistent existing-page read failure");
    securityRuntimeMock.readTextFailureInjected = false;
  });

  it.each(["index.md", "reports/open-questions.md"])(
    "leaves existing generated page %s unchanged after a non-missing read failure",
    async (relativePath) => {
      const { rootDir, config } = await createVault({
        prefix: "memory-wiki-compile-read-failure-",
        initialize: true,
        config: {
          render: {
            createBacklinks: false,
            createDashboards: relativePath.startsWith("reports/"),
          },
        },
      });
      const pagePath = path.join(rootDir, relativePath);
      const original = "# Existing page\n\n## Notes\nKeep this human-written content.\n";
      await fs.writeFile(pagePath, original, "utf8");
      securityRuntimeMock.failReadTextAlwaysFor = relativePath;

      await expect(compileMemoryWikiVault(config)).rejects.toThrow(
        "persistent existing-page read failure",
      );

      expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(original);
    },
  );

  it("preserves ingest notes after a transient existing-page read failure", async () => {
    const { pagePath, changeSource, update } = await createIngestFixture();
    const userNote = "KEY INSIGHT: covers the Q2 roadmap";
    await addNotes(pagePath, userNote);
    await changeSource();
    securityRuntimeMock.failReadTextOnceFor = pagePath;

    await update();

    const after = await fs.readFile(pagePath, "utf8");
    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it("preserves imported notes after a transient existing-page read failure", async () => {
    const { pagePath, absPage, update } = await createImportedFixture();
    const userNote = "IMPORTED PAGE NOTE FROM HUMAN";
    await addNotes(absPage, userNote);
    securityRuntimeMock.failReadTextOnceFor = pagePath;
    const result = await update();
    const after = await fs.readFile(absPage, "utf8");
    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    expect(result.changed).toBe(true);
    expect(after).toContain("second body changed");
    expect(after).toContain(userNote);
  });

  it("leaves imported source pages unchanged after a persistent existing-page read failure", async () => {
    const { pagePath, absPage, update } = await createImportedFixture();
    const before = await fs.readFile(absPage, "utf8");
    securityRuntimeMock.failReadTextAlwaysFor = pagePath;
    await expect(update()).rejects.toThrow("persistent existing-page read failure");
    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    await expect(fs.readFile(absPage, "utf8")).resolves.toBe(before);
  });

  it("leaves ingested source pages unchanged after a persistent existing-page read failure", async () => {
    const { pagePath, changeSource, update } = await createIngestFixture();
    const before = await fs.readFile(pagePath, "utf8");
    await changeSource();
    const error = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    securityRuntimeMock.failReadTextAlwaysFor = pagePath;
    securityRuntimeMock.readTextError = error;

    await expect(update()).rejects.toMatchObject({ cause: error });

    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(before);
  });

  it("preserves synthesis notes and frontmatter after a transient existing-page read failure", async () => {
    const { pagePath, update } = await createSynthesisFixture("Initial summary v1.");
    const userNote = "Ship gate: legal sign-off required before GA.";
    await addNotes(pagePath, userNote);
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      /^---\n/,
      "---\nprivacyTier: sensitive\n",
    );
    await fs.writeFile(pagePath, edited, "utf8");

    securityRuntimeMock.failReadTextOnceFor = "syntheses/release-plan.md";
    securityRuntimeMock.readTextOnceError = new FsSafeError(
      "not-found",
      "page temporarily missing",
    );

    await update("Updated summary v2.");

    const after = await fs.readFile(pagePath, "utf8");
    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    expect(after).toContain("Updated summary v2.");
    expect(after).toContain(userNote);
    expect(after).toContain("privacyTier: sensitive");
  });

  it("does not treat a path-alias policy failure as a missing synthesis page", async () => {
    const { pagePath, update } = await createSynthesisFixture("Initial summary.");
    const before = await fs.readFile(pagePath, "utf8");
    securityRuntimeMock.failReadTextAlwaysFor = "syntheses/release-plan.md";
    securityRuntimeMock.readTextError = new FsSafeError(
      "path-alias",
      "page resolved outside the vault root",
    );

    await expect(update("Replacement summary.")).rejects.toMatchObject({ code: "path-alias" });

    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(before);
  });

  it("leaves OKF concept pages unchanged after a persistent existing-page read failure", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-okf-read-failure-" });
    const bundlePath = path.join(rootDir, "bundle");
    await fs.mkdir(bundlePath);
    await fs.writeFile(
      path.join(bundlePath, "customers.md"),
      "---\ntype: Concept\ntitle: Customers\n---\nCustomer body.\n",
    );
    const first = await importMemoryWikiOkfBundle({ config, bundlePath });
    const pagePath = expectDefined(first.pagePaths[0], "imported OKF concept page");
    const absolutePath = path.join(config.vault.path, pagePath);
    await addNotes(absolutePath, "Handwritten note must survive the read failure.");
    const before = await fs.readFile(absolutePath, "utf8");
    securityRuntimeMock.failReadTextAlwaysFor = pagePath;

    await expect(importMemoryWikiOkfBundle({ config, bundlePath })).rejects.toThrow(
      "persistent existing-page read failure",
    );

    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    await expect(fs.readFile(absolutePath, "utf8")).resolves.toBe(before);
  });

  it("preserves chatgpt conversation notes containing dollar sequences and marker examples", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture();
    const userNote = [
      "Energy identity $$E=mc^2$$ and match $& and prefix $` and suffix $' end.",
      "Example marker: <!-- openclaw:human:end -->",
      "Keep this trailing handwritten note.",
    ].join("\n");
    await addNotes(pagePath, userNote);

    const second = await importChatGptConversations({
      config,
      exportPath: exportDir,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(second).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
    expect(after).toContain(userNote);
  });
});

async function changeChatGptExport(exportDir: string): Promise<void> {
  const exportFile = path.join(exportDir, "conversations.json");
  const before = await fs.readFile(exportFile, "utf8");
  const after = before.replace("I prefer aisle seats.", "I now prefer window seats.");
  expect(after).not.toBe(before);
  await fs.writeFile(exportFile, after, "utf8");
}

describe("Memory Wiki ChatGPT import rooted page paths", () => {
  it("M01 creates an ordinary page inside the vault", async () => {
    const { pagePath } = await createChatGptImportFixture("wiki-root-create-");
    await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("Travel preference check");
  });
  it("M02 updates an ordinary page with a run snapshot", async () => {
    const { config, exportDir, pagePath, rootDir } =
      await createChatGptImportFixture("wiki-root-update-");
    await changeChatGptExport(exportDir);
    const result = await importChatGptConversations({ config, exportPath: exportDir });
    expect(result.updatedCount).toBe(1);
    expect(result.runId).toBeTruthy();
    const snapshots = path.join(
      rootDir,
      ".openclaw-wiki",
      "import-runs",
      result.runId!,
      "snapshots",
    );
    expect((await fs.readdir(snapshots)).length).toBeGreaterThan(0);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("window seats");
  });
  it("M03 skips an identical page", async () => {
    const { config, exportDir } = await createChatGptImportFixture("wiki-root-skip-");
    const result = await importChatGptConversations({ config, exportPath: exportDir });
    expect(result).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
  });
  it("M04 rejects a final page symlink pointing outside", async () => {
    const { config, exportDir, pagePath } =
      await createChatGptImportFixture("wiki-root-final-alias-");
    const outside = path.join(await createTempDir("wiki-root-outside-"), "outside.md");
    await fs.writeFile(outside, "OUTSIDE", "utf8");
    await fs.rm(pagePath);
    await fs.symlink(outside, pagePath);
    await expect(
      importChatGptConversations({ config, exportPath: exportDir }),
    ).rejects.toMatchObject({ code: "symlink" });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("OUTSIDE");
  });
  it("M05 rejects a parent directory symlink pointing outside", async () => {
    const { config, exportDir, pagePath, rootDir } =
      await createChatGptImportFixture("wiki-root-parent-alias-");
    const outsideDir = await createTempDir("wiki-root-parent-outside-");
    await fs.rename(path.join(rootDir, "sources"), path.join(rootDir, "sources-original"));
    await fs.symlink(outsideDir, path.join(rootDir, "sources"), "dir");
    await expect(
      importChatGptConversations({ config, exportPath: exportDir }),
    ).rejects.toMatchObject({ code: "outside-workspace" });
    expect(await fs.readdir(outsideDir)).toEqual([]);
    expect(pagePath).toContain("sources");
  });
  it("M06 rejects a dangling final page symlink", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture("wiki-root-dangling-");
    await fs.rm(pagePath);
    await fs.symlink(path.join(await createTempDir("wiki-root-missing-"), "missing.md"), pagePath);
    await expect(
      importChatGptConversations({ config, exportPath: exportDir }),
    ).rejects.toMatchObject({ code: "symlink" });
  });
  it("M07 handles an in-vault page alias without escaping the vault", async () => {
    const { config, exportDir, pagePath, rootDir } =
      await createChatGptImportFixture("wiki-root-inside-alias-");
    const target = path.join(rootDir, "inside.md");
    const before = await fs.readFile(pagePath, "utf8");
    await fs.writeFile(target, before, "utf8");
    await fs.rm(pagePath);
    await fs.symlink(target, pagePath);
    await changeChatGptExport(exportDir);
    try {
      await importChatGptConversations({ config, exportPath: exportDir });
      await expect(fs.readFile(target, "utf8")).resolves.toContain("window seats");
    } catch (error) {
      expect(error).toMatchObject({ code: "symlink" });
      await expect(fs.readFile(target, "utf8")).resolves.toBe(before);
    }
  });
  it("M08 rejects a page swapped to an outside symlink after planning read", async () => {
    const { config, exportDir, pagePath, rootDir } =
      await createChatGptImportFixture("wiki-root-swap-");
    await changeChatGptExport(exportDir);
    const outside = path.join(await createTempDir("wiki-root-swap-outside-"), "outside.md");
    await fs.writeFile(outside, "OUTSIDE", "utf8");
    let swapped = false;
    securityRuntimeMock.onReadText = async (relativePath) => {
      if (swapped || relativePath !== path.relative(rootDir, pagePath)) return;
      swapped = true;
      await fs.rm(pagePath);
      await fs.symlink(outside, pagePath);
    };
    await expect(
      importChatGptConversations({ config, exportPath: exportDir }),
    ).rejects.toMatchObject({ code: "path-alias" });
    expect(swapped).toBe(true);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("OUTSIDE");
  });
  it("M09 rejects a snapshot parent symlink pointing outside", async () => {
    const { config, exportDir, rootDir } = await createChatGptImportFixture(
      "wiki-root-snapshot-alias-",
    );
    const outsideDir = await createTempDir("wiki-root-snapshot-outside-");
    const runs = path.join(rootDir, ".openclaw-wiki", "import-runs");
    await fs.mkdir(runs, { recursive: true });
    await fs.rename(runs, path.join(rootDir, ".openclaw-wiki", "import-runs-original"));
    await fs.symlink(outsideDir, runs, "dir");
    await changeChatGptExport(exportDir);
    await expect(
      importChatGptConversations({ config, exportPath: exportDir }),
    ).rejects.toMatchObject({ code: "path-alias" });
    expect(await fs.readdir(outsideDir)).toEqual([]);
  });
  it("M10 rolls back an ordinary update to the prior bytes", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture("wiki-root-rollback-");
    const before = await fs.readFile(pagePath, "utf8");
    await changeChatGptExport(exportDir);
    const result = await importChatGptConversations({ config, exportPath: exportDir });
    expect(result.runId).toBeTruthy();
    await rollbackChatGptImportRun({ config, runId: result.runId! });
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(before);
  });
});

afterEach(() => {
  securityRuntimeMock.onReadText = undefined;
});
