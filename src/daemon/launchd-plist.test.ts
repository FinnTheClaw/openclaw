// Launchd plist parser tests cover label extraction shared by lifecycle and diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchAgentPlist,
  parseLaunchdPlistLabel,
  quoteLaunchAgentEnvironmentValue,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(
    async (_command: string, _args: string[], options: { input: string | Uint8Array }) =>
      decodeLaunchAgentPlistFixture(options.input),
  ),
}));

describe("LaunchAgent environment round-trip", () => {
  it.each([
    "alpha\nbeta",
    "alpha\n\nbeta",
    "alpha\nexport OTHER=beta",
    "alpha\n# comment",
    "alpha'\nbeta",
    "alpha  \nbeta",
    "\nalpha\n",
    "alpha\r\nbeta",
    "plain",
    "a'b",
  ])("preserves generated literal %j through an ordinary rewrite", async (value) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plist-multiline-"));
    const plistPath = path.join(dir, "gateway.plist");
    const envPath = path.join(dir, "gateway.env");
    const programArguments = ["/bin/sh", path.join(dir, "gateway-env-wrapper.sh"), envPath, "node"];
    try {
      await fs.writeFile(
        plistPath,
        buildLaunchAgentPlist({
          label: "test.multiline",
          programArguments,
          stdoutPath: path.join(dir, "stdout"),
          stderrPath: path.join(dir, "stderr"),
        }),
      );
      let nextValue = value;
      for (let rewrite = 0; rewrite < 2; rewrite++) {
        await fs.writeFile(
          envPath,
          "export TEST_VALUE=" + quoteLaunchAgentEnvironmentValue(nextValue) + "\n",
        );
        const command = await readLaunchAgentProgramArgumentsFromFile(plistPath);
        expect(command?.environment).toEqual({ TEST_VALUE: value });
        nextValue = command!.environment!.TEST_VALUE;
        const effective = await readLaunchAgentProgramArgumentsFromFile(plistPath, {
          requireEffective: true,
          expectedEnvironmentWrapperPath: programArguments[1],
          expectedEnvironmentFilePath: envPath,
        });
        expect(effective?.environment).toEqual({ TEST_VALUE: value });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["", "--max-old-space-size=24576"])(
    "preserves explicit NODE_OPTIONS=%j while omitting other empty values",
    async (nodeOptions) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plist-env-"));
      const plistPath = path.join(dir, "gateway.plist");
      const programArguments = ["/usr/bin/node", "--max-old-space-size=16384", "gateway.js"];
      try {
        await fs.writeFile(
          plistPath,
          buildLaunchAgentPlist({
            label: "ai.openclaw.gateway",
            programArguments,
            stdoutPath: path.join(dir, "stdout.log"),
            stderrPath: path.join(dir, "stderr.log"),
            environment: { NODE_OPTIONS: nodeOptions, UNUSED: "", MISSING: undefined },
          }),
        );
        const command = await readLaunchAgentProgramArgumentsFromFile(plistPath);
        expect(command?.environment).toEqual({ NODE_OPTIONS: nodeOptions });
        expect(command?.programArguments).toEqual(programArguments);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("parseLaunchdPlistLabel", () => {
  it("decodes the XML entities accepted in launchd labels", () => {
    expect(
      parseLaunchdPlistLabel(
        "<plist><dict><key>Label</key><string>ai.openclaw.a&amp;b</string></dict></plist>",
      ),
    ).toBe("ai.openclaw.a&b");
  });

  it("returns null for missing or empty labels", () => {
    expect(parseLaunchdPlistLabel("<plist><dict/></plist>")).toBeNull();
    expect(
      parseLaunchdPlistLabel("<plist><dict><key>Label</key><string>  </string></dict></plist>"),
    ).toBeNull();
  });
});
