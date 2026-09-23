// ACPX tests cover mcp command line plugin behavior.
import { describe, expect, it } from "vitest";

type SplitCommandLine = (
  value: string,
  platform?: string,
) => {
  command: string;
  args: string[];
};

async function loadSplitCommandLine(): Promise<SplitCommandLine> {
  const moduleUrl = new URL("./mcp-command-line.mjs", import.meta.url);
  return (await import(moduleUrl.href)).splitCommandLine as SplitCommandLine;
}

describe("mcp-command-line", () => {
  it("parses quoted Windows executable paths without dropping backslashes", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --stdio --flag "two words"',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--stdio", "--flag", "two words"],
    });
  });

  it("parses unquoted Windows executable paths without mangling backslashes", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine("C:\\Users\\alerl\\.local\\bin\\claude.exe --version", "win32");

    expect(parsed).toEqual({
      command: "C:\\Users\\alerl\\.local\\bin\\claude.exe",
      args: ["--version"],
    });
  });

  it("preserves unquoted Windows path arguments after the executable", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --config C:\\Users\\me\\cfg.json',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--config", "C:\\Users\\me\\cfg.json"],
    });
  });

  it("rejects direct Windows wrapper-script commands with a helpful error", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    expect(() =>
      splitCommandLine('"C:\\Users\\me\\bin\\claude-wrapper.cmd" --stdio', "win32"),
    ).toThrow(/Invoke wrapper scripts through their shell or interpreter instead/);
  });
  it.each([
    {
      name: "L4-02 retains a double-quoted empty first argument",
      input: 'agent ""',
      platform: "linux",
      args: [""],
    },
    {
      name: "L4-02 retains a single-quoted empty first argument",
      input: "agent ''",
      platform: "linux",
      args: [""],
    },
    {
      name: "L4-02 retains an empty argument before a nonempty one",
      input: 'agent "" next',
      platform: "linux",
      args: ["", "next"],
    },
    {
      name: "L4-02 retains an empty argument after a nonempty one",
      input: 'agent next ""',
      platform: "linux",
      args: ["next", ""],
    },
    {
      name: "L4-02 retains two consecutive empty arguments",
      input: 'agent "" ""',
      platform: "linux",
      args: ["", ""],
    },
    {
      name: "L4-02 allows empty quotes inside a nonempty argument",
      input: 'agent a""b',
      platform: "linux",
      args: ["ab"],
    },
    {
      name: "L4-02 coalesces adjacent empty quote pairs into one argument",
      input: "agent \"\"''",
      platform: "linux",
      args: [""],
    },
    {
      name: "L4-02 retains an empty argument after a spaced quoted argument",
      input: 'agent "one two" ""',
      platform: "linux",
      args: ["one two", ""],
    },
    {
      name: "L4-02 retains an empty argument after a quoted Windows executable",
      input: '"C:\\Program Files\\agent.exe" ""',
      platform: "win32",
      args: [""],
    },
    {
      name: "L4-02 retains an empty argument after an unquoted Windows executable path",
      input: 'C:\\Program Files\\agent.exe "" next',
      platform: "win32",
      args: ["", "next"],
    },
  ])("$name", async ({ input, platform, args }) => {
    const splitCommandLine = await loadSplitCommandLine();
    expect(splitCommandLine(input, platform)).toEqual({
      command: platform === "win32" ? "C:\\Program Files\\agent.exe" : "agent",
      args,
    });
  });
});
