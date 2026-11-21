import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isPidAlive, runExec } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runExec: vi.fn(),
  isPidAlive: vi.fn(() => true),
}));

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(async () => {}),
}));

export type AcpxProcessSystemFixture = {
  listProcesses?: () => Promise<
    Array<{ pid: number; ppid: number; command: string; startIdentity?: string }>
  >;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
};

export function mockAcpxProcessSystem(fixture: AcpxProcessSystemFixture = {}) {
  let currentRows: Array<{ pid: number; ppid: number; command: string; startIdentity?: string }> =
    [];
  const identities = new Map<string, number>();
  const ordinal = (row: { pid: number; startIdentity?: string }) => {
    const key = row.startIdentity ?? `fixture-${row.pid}`;
    if (!identities.has(key)) identities.set(key, identities.size + 1);
    return identities.get(key)!;
  };
  const originalReadFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(args[0]));
    if (!match) return originalReadFile(...args);
    const pid = Number(match[1]);
    const row = currentRows.find((candidate) => candidate.pid === pid);
    if (!row) return Promise.reject(new Error("fixture process exited"));
    // Model field22 without reading or signaling any real fixture PID.
    return Promise.resolve(`${pid} (fixture) S ${Array(18).fill("0").join(" ")} ${ordinal(row)} 0`);
  });
  vi.spyOn(process, "platform", "get").mockReturnValue(fixture.platform ?? "linux");
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    fixture.killProcess?.(pid, signal as NodeJS.Signals);
    return true;
  });
  vi.mocked(runExec)
    .mockReset()
    .mockImplementation(async () => {
      currentRows = (await fixture.listProcesses?.()) ?? [];
      return {
        stdout: currentRows
          .map((row) => {
            const day = ordinal(row);
            return `${row.pid} ${row.ppid} Mon Jan ${day} 00:00:00 2026 ${row.command}`;
          })
          .join("\n"),
        stderr: "",
      };
    });
  vi.mocked(isPidAlive).mockReset().mockReturnValue(true);
  vi.mocked(delay)
    .mockReset()
    .mockImplementation(async (ms) => {
      await fixture.sleep?.(ms ?? 0);
    });
  return { runExec: vi.mocked(runExec), kill };
}

afterEach(() => {
  vi.restoreAllMocks();
});
