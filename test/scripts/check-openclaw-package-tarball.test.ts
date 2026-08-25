// Check Openclaw Package Tarball tests cover check openclaw package tarball script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
const FLAT_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/provider-entry.d.ts";
const DEEP_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts";
const AI_RUNTIME_PACKAGE_JSON = JSON.stringify({
  name: "@openclaw/ai",
  version: "2026.6.11",
  exports: {
    ".": { import: "./dist/index.mjs" },
    "./providers": { import: "./dist/providers.mjs" },
    "./internal/*": { import: "./dist/internal/*.mjs" },
  },
});

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string) => void,
  version = "0.0.0",
  options: {
    includeControlUi?: boolean;
    includeShrinkwrap?: boolean;
    packageJson?: Record<string, unknown>;
    shrinkwrapRootPackage?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version, ...options.packageJson }),
    );
    if (options.includeShrinkwrap !== false) {
      writeFileSync(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version,
          lockfileVersion: 3,
          packages: {
            "": {
              name: "openclaw",
              version,
              ...options.shrinkwrapRootPackage,
            },
          },
        }),
      );
    }
    writeFileSync(
      join(packageRoot, "dist", "postinstall-inventory.json"),
      JSON.stringify(inventory),
    );
    const tarFiles =
      options.includeControlUi === false
        ? files
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
            ...files,
          };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }

    const tarball = join(root, "openclaw.tgz");
    const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
      encoding: "utf8",
    });
    expect(pack.status, pack.stderr).toBe(0);
    testBody(tarball);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-openclaw-package-tarball", () => {
  it("prints help before touching tarball state", () => {
    const result = spawnSync("node", [CHECK_SCRIPT, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node scripts/check-openclaw-package-tarball.mjs [--require-bundled-workspace-deps] <openclaw.tgz>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects option-like and extra arguments before tar inspection", () => {
    const unknown = spawnSync("node", [CHECK_SCRIPT, "--tag"], { encoding: "utf8" });

    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown OpenClaw package tarball check option: --tag");
    expect(unknown.stderr).not.toContain("OpenClaw package tarball does not exist");

    const extra = spawnSync("node", [CHECK_SCRIPT, "openclaw.tgz", "extra"], {
      encoding: "utf8",
    });

    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain("Unexpected OpenClaw package tarball check argument: extra");
    expect(extra.stderr).not.toContain("OpenClaw package tarball does not exist");
  });

  it("allows private governor authority bodies in hashed dist chunks", () => {
    withTarball(
      ["dist/governor-host-bootstrap-1PwSH9Yi.js"],
      {
        "dist/governor-host-bootstrap-1PwSH9Yi.js":
          "function createGovernorMemoryAuthority() {}\nexport { createGovernorHostRuntimeIfEnabled };\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
      },
    );
  });

  it.each([
    ["test factory", "function createGovernorTestBindings() {}\n"],
    ["synthetic secrets", "function syntheticGovernorSecretsEnvironment() {}\n"],
  ])("rejects private governor %s bodies in hashed chunks", (_label, body) => {
    withTarball(
      ["dist/governor-test-internals-a1B2.js"],
      { "dist/governor-test-internals-a1B2.js": body },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("forbidden shipped governor test-only marker");
      },
    );
  });

  it("allows only the canonical bootstrap export from an authority-bearing chunk", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      {
        "dist/governor-host-bootstrap-a1B2.js":
          "function createMemoryAuthorityOwner() {}\nfunction createGovernorHostRuntimeIfEnabled() {}\nexport { createGovernorHostRuntimeIfEnabled };\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
      },
    );
  });

  it("rejects a governor bootstrap inventory with no durable authority marker", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      {
        "dist/governor-host-bootstrap-a1B2.js":
          "function createGovernorHostRuntimeIfEnabled() {}\nexport { createGovernorHostRuntimeIfEnabled };\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "governor host bootstrap dist inventory contains no durable authority marker",
        );
      },
    );
  });

  it("rejects extra exports from an authority-bearing chunk", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      {
        "dist/governor-host-bootstrap-a1B2.js":
          "function createMemoryAuthorityOwner() {}\nexport function safe() { return createMemoryAuthorityOwner(); }\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "unexpected governor authority-bearing export safe in dist/governor-host-bootstrap-a1B2.js",
        );
      },
    );
  });

  it("rejects star-expanded exports from an authority-bearing chunk", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js", "dist/unrelated-c3D4.js"],
      {
        "dist/governor-host-bootstrap-a1B2.js":
          'function createMemoryAuthorityOwner() {}\nexport * from "./unrelated-c3D4.js";\n',
        "dist/unrelated-c3D4.js": "export const safe = true;\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "unexpected governor authority-bearing export safe in dist/governor-host-bootstrap-a1B2.js",
        );
      },
    );
  });

  it("rejects an anonymous default export from an authority-bearing chunk", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      {
        "dist/governor-host-bootstrap-a1B2.js":
          "function createMemoryAuthorityOwner() {}\nexport default function() { return createMemoryAuthorityOwner(); }\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "unexpected governor authority-bearing export default in dist/governor-host-bootstrap-a1B2.js",
        );
      },
    );
  });

  it.each([
    [
      "renamed",
      'export { createGovernorHostRuntimeIfEnabled as safe } from "./authority-a1B2.js";\n',
    ],
    ["namespace", 'export * as safe from "./authority-a1B2.js";\n'],
  ])("rejects a %s reexport of the canonical authority binding", (_label, reexport) => {
    withTarball(
      ["dist/authority-a1B2.js", "dist/governor-entry-c3D4.js"],
      {
        "dist/authority-a1B2.js":
          "function createMemoryAuthorityOwner() {}\nfunction createGovernorHostRuntimeIfEnabled() {}\nexport { createGovernorHostRuntimeIfEnabled };\n",
        "dist/governor-entry-c3D4.js": reexport,
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "unexpected governor authority-bearing export safe in dist/governor-entry-c3D4.js",
        );
      },
    );
  });

  it.each([
    [
      "named import/export",
      'import { createGovernorHostRuntimeIfEnabled as safe } from "./authority-a1B2.js";\nexport { safe };\n',
    ],
    [
      "namespace import/export",
      'import * as gov from "./authority-a1B2.js";\nexport { gov as safe };\n',
    ],
    [
      "local identifier chain",
      'import { createGovernorHostRuntimeIfEnabled as local } from "./authority-a1B2.js";\nconst middle = local;\nexport { middle as safe };\n',
    ],
    [
      "default local alias",
      'import { createGovernorHostRuntimeIfEnabled as local } from "./authority-a1B2.js";\nexport default local;\n',
    ],
    [
      "array data alias",
      'import { createGovernorHostRuntimeIfEnabled as local } from "./authority-a1B2.js";\nexport const safe = [local];\n',
    ],
    [
      "array destructuring alias",
      'import { createGovernorHostRuntimeIfEnabled as local } from "./authority-a1B2.js";\nconst [safe] = [local];\nexport { safe };\n',
    ],
    [
      "namespace destructuring alias",
      'import * as gov from "./authority-a1B2.js";\nconst { createGovernorHostRuntimeIfEnabled: safe } = gov;\nexport { safe };\n',
    ],
    [
      "namespace element access alias",
      'import * as gov from "./authority-a1B2.js";\nexport const safe = gov["createGovernorHostRuntimeIfEnabled"];\n',
    ],
    [
      "destructuring default alias",
      'import { createGovernorHostRuntimeIfEnabled as local } from "./authority-a1B2.js";\nconst { missing = local } = {};\nexport { missing as safe };\n',
    ],
  ])("rejects a two-statement %s authority alias", (_label, reexport) => {
    withTarball(
      ["dist/authority-a1B2.js", "dist/governor-entry-c3D4.js"],
      {
        "dist/authority-a1B2.js":
          "function createMemoryAuthorityOwner() {}\nfunction createGovernorHostRuntimeIfEnabled() {}\nexport { createGovernorHostRuntimeIfEnabled };\n",
        "dist/governor-entry-c3D4.js": reexport,
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unexpected governor authority-bearing export");
      },
    );
  });

  it.each([
    ["named", "export function createGovernorMemoryAuthority() {}\n"],
    ["default", "function closeGovernorMemoryAuthority() {}\nexport default closeGovernorMemoryAuthority;\n"],
    ["reexport", 'export { isTrustedGovernorMemoryAuthority } from "./authority.js";\n'],
    ["test factory", "const createGovernorTestHostBindings = () => {};\nexport { createGovernorTestHostBindings };\n"],
    ["current bindings factory", "export function createGovernorTestBindings() {}\n"],
    ["current broker factory", "export const createGovernorTestBroker = () => {};\n"],
    [
      "current store factory",
      "const createGovernorTestStore = () => {};\nexport { createGovernorTestStore };\n",
    ],
  ])("rejects %s governor authority exports in hashed dist chunks", (_label, body) => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2c3D4.js"],
      { "dist/governor-host-bootstrap-a1B2c3D4.js": body },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("forbidden governor authority export");
      },
    );
  });

  it("rejects forbidden authority names exposed through star reexports", () => {
    withTarball(
      ["dist/authority-a1B2.js", "dist/governor-host-bootstrap-c3D4.js"],
      {
        "dist/authority-a1B2.js": "export function createGovernorMemoryAuthority() {}\n",
        "dist/governor-host-bootstrap-c3D4.js": 'export * from "./authority-a1B2.js";\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden governor authority export createGovernorMemoryAuthority in dist/governor-host-bootstrap-c3D4.js",
        );
      },
    );
  });

  it("rejects forbidden authority exposed through namespace reexports", () => {
    withTarball(
      ["dist/authority-a1B2.js", "dist/governor-host-bootstrap-c3D4.js"],
      {
        "dist/authority-a1B2.js": "export function closeGovernorMemoryAuthority() {}\n",
        "dist/governor-host-bootstrap-c3D4.js":
          'export * as safeAuthority from "./authority-a1B2.js";\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden governor authority export closeGovernorMemoryAuthority in dist/governor-host-bootstrap-c3D4.js",
        );
      },
    );
  });

  it.each([
    ["shorthand", "const createGovernorMemoryAuthority = () => {}; export default { createGovernorMemoryAuthority };\n"],
    ["aliased", "const closeGovernorMemoryAuthority = () => {}; export const safe = { close: closeGovernorMemoryAuthority };\n"],
    ["identifier", "const createGovernorMemoryAuthority = () => {}; const safe = { createGovernorMemoryAuthority }; export default safe;\n"],
  ])("rejects authority exposed through an exported %s object", (_label, body) => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      { "dist/governor-host-bootstrap-a1B2.js": body },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("forbidden governor authority export");
      },
    );
  });

  it.each([
    [
      "named alias",
      "const createGovernorMemoryAuthority = () => {}; const safe = { createGovernorMemoryAuthority }; export { safe };\n",
    ],
    [
      "multi-hop alias",
      "const createGovernorMemoryAuthority = () => {}; const owner = { createGovernorMemoryAuthority }; const middle = owner; const safe = { ...middle }; export { safe as default };\n",
    ],
  ])("rejects authority exposed through a local %s export", (_label, body) => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      { "dist/governor-host-bootstrap-a1B2.js": body },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("forbidden governor authority export");
      },
    );
  });

  it("rejects malformed shipped JavaScript instead of scanning a partial AST", () => {
    withTarball(
      ["dist/governor-host-bootstrap-a1B2.js"],
      { "dist/governor-host-bootstrap-a1B2.js": "export {\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unparseable dist JavaScript");
      },
    );
  });

  it("does not reject unrelated packaged test helpers", () => {
    withTarball(
      ["dist/channels/test-helpers/fixture.js"],
      { "dist/channels/test-helpers/fixture.js": "export const fixture = true;\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
      },
    );
  });

  it.each([
    "dist/governor-test-host-bindings-Ha5h3d.js",
    "dist/security/test-helpers/governor-test-host-bindings.js",
    "dist/tasks/governor/test-broker-Ha5h3d.js",
    "dist/tasks/governor/memory-contradiction-test-helpers.js",
    "src/security/governor-host-memory-authority.ts",
  ])("rejects governor test-helper or source authority tar entry %s", (forbiddenEntry) => {
    withTarball([forbiddenEntry], { [forbiddenEntry]: "export {};\n" }, (tarball) => {
      const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/forbidden governor (?:test-helper|source authority) tar entry/u);
    });
  });

  it.runIf(process.platform !== "win32")(
    "removes the extract dir when tar extraction fails",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-extract-fail-"));
      try {
        const fakeBin = join(root, "bin");
        mkdirSync(fakeBin);
        const extractDirFile = join(root, "extract-dir.txt");
        const fakeTar = join(fakeBin, "tar");
        writeFileSync(
          fakeTar,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const args = process.argv.slice(2);",
            "if (args[0] === '-tf') { console.log('package/package.json'); process.exit(0); }",
            "const outputDir = args[args.indexOf('-C') + 1];",
            "fs.writeFileSync(process.env.OPENCLAW_TEST_EXTRACT_DIR_FILE, outputDir);",
            "console.error('extract denied');",
            "process.exit(7);",
          ].join("\n"),
        );
        chmodSync(fakeTar, 0o755);
        const tarball = join(root, "openclaw.tgz");
        writeFileSync(tarball, "not used by fake tar");

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_EXTRACT_DIR_FILE: extractDirFile,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("extract denied");
        expect(existsSync(readFileSync(extractDirFile, "utf8"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("allows legacy private QA inventory entries omitted from shipped tarballs through 2026.4.25", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy inventory references omitted private QA");
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.25-beta.10",
    );
  });

  it("rejects legacy private QA inventory omissions for newer packages", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory references missing tar entry dist/extensions/qa-channel/runtime-api.js",
        );
        expect(result.stderr).not.toContain("legacy inventory references omitted private QA");
      },
      "2026.4.26",
    );
  });

  it("still rejects non-legacy missing inventory entries", () => {
    withTarball(
      ["dist/index.js", "dist/cli.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory references missing tar entry dist/cli.js");
      },
    );
  });

  it("rejects stale deep plugin SDK declaration inventory entries", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION, DEEP_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `inventory references missing tar entry ${DEEP_PLUGIN_SDK_DECLARATION}`,
        );
      },
    );
  });

  it("accepts flat plugin SDK declaration inventory without the old deep tree", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
    );
  });

  it("rejects dist files that import missing relative chunks", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      { "dist/cli/run-main.js": 'await import("../memory-state-old.js");\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "dist/cli/run-main.js imports missing dist/memory-state-old.js",
        );
      },
      "2026.4.27",
    );
  });

  it("accepts dist files whose relative chunks are present", () => {
    withTarball(
      ["dist/cli/run-main.js", "dist/memory-state-current.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects imported dist chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory omits imported dist file dist/memory-state-current.js",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects CommonJS require chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.cjs"],
      {
        "dist/index.cjs": 'module.exports = require("./chunk.cjs");\n',
        "dist/chunk.cjs": "module.exports = {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/chunk.cjs");
      },
      "2026.4.27",
    );
  });

  it("rejects dist files with missing import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects formatted import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": [
          "const worker = new URL(",
          '  "./worker.js",',
          "  import.meta.url,",
          ");",
          "",
        ].join("\n"),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects import.meta.url URL dependencies omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n',
        "dist/worker.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url package-root probes", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const root = new URL("../..", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url source helper probes", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js":
          'const shim = new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url);\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects missing Control UI assets", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry dist/control-ui/index.html");
        expect(result.stderr).toContain(
          "missing required tar entries under dist/control-ui/assets/",
        );
      },
      "2026.4.27",
      { includeControlUi: false },
    );
  });

  it("allows legacy package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy package omits npm-shrinkwrap.json");
      },
      "2026.5.20",
      { includeShrinkwrap: false },
    );
  });

  it("rejects new package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry npm-shrinkwrap.json");
      },
      "2026.5.21",
      { includeShrinkwrap: false },
    );
  });

  it("rejects package-lock.json in package tarballs", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n", "package-lock.json": "{}\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package tarball must ship npm-shrinkwrap.json, not package-lock.json",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects workspace protocol dependencies in package manifests", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must not use workspace protocol workspace:*",
        );
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "workspace:*" } } },
    );
  });

  it("rejects workspace protocol dependencies in shrinkwrap root metadata", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "npm-shrinkwrap.json packages root dependencies.@openclaw/ai must not use workspace protocol workspace:*",
        );
      },
      "2026.6.11",
      { shrinkwrapRootPackage: { dependencies: { "@openclaw/ai": "workspace:*" } } },
    );
  });

  it("accepts separately published private workspace dependencies by default", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
    );
  });

  it("rejects private workspace dependencies that are not bundled when strict packaging requires it", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must be listed in bundleDependencies because it is private to the OpenClaw workspace",
        );
        expect(result.stderr).toContain(
          "package.json dependencies.@openclaw/ai must be bundled in node_modules/@openclaw/ai",
        );
      },
      "2026.6.11",
      { packageJson: { dependencies: { "@openclaw/ai": "2026.6.11" } } },
    );
  });

  it("rejects private workspace dependencies when only metadata is bundled", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/index.mjs",
        );
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/providers.mjs",
        );
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/internal/runtime.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("accepts private workspace dependencies when their runtime is bundled", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects a missing required bundled AI runtime entry", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai is missing required runtime entry dist/providers.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects bundled AI entries that its manifest does not export", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": JSON.stringify({
          name: "@openclaw/ai",
          version: "2026.6.11",
          exports: {
            ".": "./dist/index.mjs",
            "./providers": null,
            "./internal/*": "./dist/internal/*.mjs",
          },
        }),
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai runtime specifier @openclaw/ai/providers is not resolvable",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects missing relative imports from bundled AI runtime entries", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "node_modules/@openclaw/ai/package.json": AI_RUNTIME_PACKAGE_JSON,
        "node_modules/@openclaw/ai/dist/index.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/providers.mjs": "export {};\n",
        "node_modules/@openclaw/ai/dist/internal/runtime.mjs": 'export * from "./missing.mjs";\n',
      },
      (tarball) => {
        const result = spawnSync(
          "node",
          [CHECK_SCRIPT, "--require-bundled-workspace-deps", tarball],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "bundled @openclaw/ai dist/internal/runtime.mjs imports missing dist/internal/missing.mjs",
        );
      },
      "2026.6.11",
      {
        packageJson: {
          dependencies: { "@openclaw/ai": "2026.6.11" },
          bundleDependencies: ["@openclaw/ai"],
        },
      },
    );
  });

  it("rejects local build metadata entries in package tarballs", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.runtime-postbuildstamp",
        );
      },
      "2026.4.27",
    );
  });

  it("allows local build metadata in already published legacy packages through 2026.4.26", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.runtime-postbuildstamp",
        );
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.26",
    );
  });
});
