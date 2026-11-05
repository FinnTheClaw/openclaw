import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProtocolSchemaDocument } from "../../../../scripts/lib/protocol-schema-document.mts";
import {
  assertPublishedProtocolSchema,
  buildInstalledProtocolInspectionScript,
  buildPortableSwiftAnyCodableSource,
  parseGatewayProtocolArtifactOptions,
  withPreservedPackageOutputs,
} from "./gateway-protocol-artifacts.js";

describe("Gateway protocol artifact producer", () => {
  it.each(["first move", "second move", "callback"] as const)(
    "preserves original protocol outputs when backup preparation fails (%s)",
    async (failure) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-protocol-preservation-"));
      const packageRoot = path.join(repoRoot, "packages", "gateway-protocol");
      const dist = path.join(packageRoot, "dist");
      const builtFile = path.join(dist, "index.mjs");
      const schema = path.join(packageRoot, "protocol.schema.json");
      const sibling = path.join(packageRoot, "unrelated.txt");
      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(builtFile, "original generated module\n", { mode: 0o640 });
      await fs.writeFile(schema, "original generated schema\n", { mode: 0o640 });
      await fs.writeFile(sibling, "unrelated package file\n", { mode: 0o600 });
      const originalModes = await Promise.all(
        [dist, builtFile, schema].map(async (target) => (await fs.stat(target)).mode & 0o777),
      );
      const injected = Object.assign(new Error("Synthetic protocol preservation failure"), {
        code: failure === "first move" ? "EXDEV" : "EACCES",
      });
      const backupRoots = new Set<string>();
      const rename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (typeof from === "string" && (from === dist || from === schema)) {
          backupRoots.add(path.dirname(String(to)));
          if (
            (failure === "first move" && from === dist) ||
            (failure === "second move" && from === schema)
          ) {
            throw injected;
          }
        }
        await rename(from, to);
      });
      const run = vi.fn(async () => {
        throw injected;
      });
      try {
        let error: unknown;
        try {
          await withPreservedPackageOutputs(repoRoot, run);
        } catch (caught) {
          error = caught;
        }
        expect.soft(error).toBe(injected);
        expect.soft(run).toHaveBeenCalledTimes(failure === "callback" ? 1 : 0);
        expect
          .soft(await fs.readFile(builtFile, "utf8").catch(() => undefined))
          .toBe("original generated module\n");
        expect
          .soft(await fs.readFile(schema, "utf8").catch(() => undefined))
          .toBe("original generated schema\n");
        expect.soft(await fs.readFile(sibling, "utf8")).toBe("unrelated package file\n");
        for (const [index, target] of [dist, builtFile, schema].entries()) {
          const mode = await fs.stat(target).then(
            (stat) => stat.mode & 0o777,
            () => undefined,
          );
          expect.soft(mode).toBe(originalModes[index]);
        }
        for (const backupRoot of backupRoots) {
          expect
            .soft(
              await fs.access(backupRoot).then(
                () => true,
                () => false,
              ),
            )
            .toBe(false);
        }
      } finally {
        renameSpy.mockRestore();
        await fs.rm(repoRoot, { recursive: true, force: true });
        for (const backupRoot of backupRoots) {
          await fs.rm(backupRoot, { recursive: true, force: true });
        }
      }
    },
  );

  it("parses one artifact directory", () => {
    expect(
      parseGatewayProtocolArtifactOptions(["--artifact-base", ".artifacts/protocol"], "/repo"),
    ).toEqual({
      artifactBase: "/repo/.artifacts/protocol",
      repoRoot: "/repo",
    });
    expect(() => parseGatewayProtocolArtifactOptions([])).toThrow("--artifact-base is required");
    expect(() =>
      parseGatewayProtocolArtifactOptions(["--artifact-base", "one", "--artifact-base", "two"]),
    ).toThrow("--artifact-base was provided more than once");
  });

  it("requires the published schema and built registry to match canonical definitions", () => {
    const definitions = {
      ConnectParams: { type: "object" },
      EventFrame: { type: "object" },
      RequestFrame: { type: "object" },
      ResponseFrame: { type: "object" },
    };
    const canonical = buildProtocolSchemaDocument({
      methods: [{ name: "health", scope: "operator.read", since: "2026.7" }],
      schemas: definitions,
    });

    expect(() =>
      assertPublishedProtocolSchema({
        builtSchemas: definitions,
        canonical,
        published: canonical,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishedProtocolSchema({
        builtSchemas: definitions,
        canonical,
        published: {
          ...canonical,
          definitions: {
            ...definitions,
            EventFrame: { type: "string" },
          },
        },
      }),
    ).toThrow("published protocol.schema.json differs");
  });

  it("loads installed artifacts through their public package specifiers", () => {
    const script = buildInstalledProtocolInspectionScript();

    expect(script).toContain('from "@openclaw/gateway-protocol"');
    expect(script).toContain('from "@openclaw/gateway-protocol/schema"');
    expect(script).not.toContain("dist/index.mjs");
    expect(script).not.toContain("dist/schema.mjs");
  });

  it("makes the AnyCodable dependency portable for standalone Linux compilation", () => {
    expect(buildPortableSwiftAnyCodableSource("import Foundation\n")).toBe(
      "import CoreFoundation\nimport Foundation\n",
    );
    expect(buildPortableSwiftAnyCodableSource("import CoreFoundation\n")).toBe(
      "import CoreFoundation\n",
    );
  });
});
