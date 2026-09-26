import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pidAlive from "../shared/pid-alive.js";
import { terminateLocalTuiProcesses } from "./doctor-whatsapp-responsiveness.test-support.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

type Signal = "SIGTERM" | "SIGKILL" | 0;
type ProcessController = { kill(pid: number, signal: Signal): boolean };
type Candidate = { pid: number; command: string; startTime: number | null };

let psOutput = "";
const posixIt = process.platform === "win32" ? it.skip : it;

function setPsRows(...rows: string[]) {
  psOutput = rows.join("\n");
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command === "ps" && args[0] === "-axo") {
      return { status: 0, stdout: psOutput };
    }
    return { status: 1, stdout: "" };
  });
}

function setIdentity(read: (pid: number) => number | null) {
  vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation(read);
}

function row(pid: number, command = "openclaw-tui --review-case") {
  return `${pid} ${command}`;
}

function makeController(params: {
  alive: Set<number>;
  onSignal?: (pid: number, signal: Exclude<Signal, 0>) => void;
}): { controller: ProcessController; calls: Array<[number, Signal]> } {
  const calls: Array<[number, Signal]> = [];
  const controller: ProcessController = {
    kill(pid, signal) {
      calls.push([pid, signal]);
      if (signal === 0) {
        if (params.alive.has(pid)) {
          return true;
        }
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      params.onSignal?.(pid, signal);
      return true;
    },
  };
  return { controller, calls };
}

function makeCandidate(pid: number, startTime: number | null = 11): Candidate {
  return { pid, command: "openclaw-tui --review-case", startTime };
}

type OwnedChild = {
  child: ChildProcess;
  pid: number;
  command: string;
  startTime: number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function startOwnedTui(script: string, caseName: string): Promise<OwnedChild> {
  const { spawn } = await import("node:child_process");
  const childScript = `${script}; if (typeof process.send === "function") process.send("doctor-tui-ready")`;
  const child = spawn(process.execPath, ["-e", childScript], {
    argv0: "openclaw-tui",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", (message) =>
      message === "doctor-tui-ready"
        ? resolve()
        : reject(new Error(`owned ${caseName} child sent an unexpected readiness message`)),
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`owned ${caseName} child exited before ready (${code}, ${signal})`)),
    );
  });
  await once(child, "spawn");
  await ready;
  if (!child.pid) {
    throw new Error(`owned ${caseName} child did not receive a PID`);
  }
  const pid = child.pid;
  const command = `openclaw-tui --owned-${caseName}`;
  setPsRows(row(pid, command));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const startTime = pidAlive.getFileLockProcessStartTime(pid);
  if (startTime === null) {
    child.kill("SIGKILL");
    await exit;
    throw new Error(`could not read owned ${caseName} child identity`);
  }
  return { child, pid, command, startTime, exit };
}

async function cleanOwnedChild(owned: OwnedChild) {
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    if (pidAlive.getFileLockProcessStartTime(owned.pid) === owned.startTime) {
      owned.child.kill("SIGKILL");
    }
    await owned.exit;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setPsRows();
});

describe("CP100 doctor repair process-identity cases", () => {
  it("CP100-DR01: sends TERM to the same verified candidate and reports it stopped", async () => {
    setIdentity(() => 11);
    setPsRows(row(101));
    const alive = new Set([101]);
    const { controller, calls } = makeController({
      alive,
      onSignal: (pid, signal) => signal === "SIGTERM" && alive.delete(pid),
    });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(101)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(calls).toEqual([
      [101, "SIGTERM"],
      [101, 0],
    ]);
  });

  it("CP100-DR02: escalates only the same verified candidate still alive after TERM", async () => {
    setIdentity(() => 11);
    setPsRows(row(102));
    const alive = new Set([102]);
    const { controller, calls } = makeController({
      alive,
      onSignal: (pid, signal) => signal === "SIGKILL" && alive.delete(pid),
    });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(102)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [102], failed: [] });
    expect(calls).toEqual([
      [102, "SIGTERM"],
      [102, 0],
      [102, "SIGKILL"],
      [102, 0],
    ]);
  });

  it("CP100-DR03: skips TERM when the start identity changed before the first signal", async () => {
    setIdentity(() => 12);
    setPsRows(row(103));
    const { controller, calls } = makeController({ alive: new Set([103]) });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(103, 11)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [], failed: [103] });
    expect(calls).toEqual([[103, 0]]);
  });

  it("CP100-DR04: skips KILL when identity changes after TERM", async () => {
    let afterTerm = false;
    setIdentity(() => (afterTerm ? 12 : 11));
    setPsRows(row(104));
    const alive = new Set([104]);
    const { controller, calls } = makeController({
      alive,
      onSignal: (_pid, signal) => signal === "SIGTERM" && (afterTerm = true),
    });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(104)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [], failed: [104] });
    expect(calls).toEqual([
      [104, "SIGTERM"],
      [104, 0],
    ]);
  });

  it("CP100-DR05: skips TERM when the fresh command no longer matches the candidate", async () => {
    setIdentity(() => 11);
    setPsRows(row(105, "/bin/sh unrelated-worker"));
    const { controller, calls } = makeController({ alive: new Set([105]) });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(105)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [], failed: [105] });
    expect(calls).toEqual([[105, 0]]);
  });

  it("CP100-DR06: fails closed without a captured start identity", async () => {
    setIdentity(() => null);
    setPsRows(row(106));
    const { controller, calls } = makeController({ alive: new Set([106]) });

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(106, null)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [], failed: [106] });
    expect(calls).toEqual([[106, 0]]);
  });

  it("CP100-DR07: does not escalate after TERM reports ESRCH and a replacement appears", async () => {
    let afterTerm = false;
    setIdentity(() => (afterTerm ? 22 : 11));
    setPsRows(row(107));
    const calls: Array<[number, Signal]> = [];
    const controller: ProcessController = {
      kill(pid, signal) {
        calls.push([pid, signal]);
        if (signal === "SIGTERM") {
          afterTerm = true;
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        if (signal === 0) {
          return true; // A replacement occupies the PID; it must not receive KILL.
        }
        throw new Error("unexpected signal");
      },
    };

    await expect(
      terminateLocalTuiProcesses({ processes: [makeCandidate(107)], controller, graceMs: 0 }),
    ).resolves.toEqual({ stopped: [], failed: [107] });
    expect(calls).toEqual([
      [107, "SIGTERM"],
      [107, 0],
    ]);
  });

  it("CP100-DR08: handles multiple candidates independently and signals only the stable one", async () => {
    setIdentity((pid) => (pid === 108 ? 11 : 99));
    setPsRows(row(108), row(208, "openclaw-tui --other-case"));
    const alive = new Set([108, 208]);
    const { controller, calls } = makeController({
      alive,
      onSignal: (pid, signal) => signal === "SIGKILL" && alive.delete(pid),
    });

    await expect(
      terminateLocalTuiProcesses({
        processes: [makeCandidate(108, 11), makeCandidate(208, 22)],
        controller,
        graceMs: 0,
      }),
    ).resolves.toEqual({ stopped: [108], failed: [208] });
    expect(calls.filter(([, signal]) => signal !== 0)).toEqual([
      [108, "SIGTERM"],
      [108, "SIGKILL"],
    ]);
    expect(calls.filter(([pid]) => pid === 208)).toEqual([[208, 0]]);
  });

  posixIt("CP100-DR09: sends TERM to an owned child and records its actual exit", async () => {
    vi.restoreAllMocks();
    const owned = await startOwnedTui(
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
      "term-exits",
    );
    let actualExitObserved = false;
    void owned.exit.then(() => {
      actualExitObserved = true;
    });
    const controller: ProcessController = {
      kill(pid, signal) {
        expect(pid).toBe(owned.pid);
        if (signal === 0) {
          if (actualExitObserved) {
            throw Object.assign(new Error("gone"), { code: "ESRCH" });
          }
          return process.kill(pid, 0);
        }
        return process.kill(pid, signal);
      },
    };

    try {
      const result = await terminateLocalTuiProcesses({
        processes: [{ pid: owned.pid, command: owned.command, startTime: owned.startTime }],
        controller,
        graceMs: 250,
      });
      const actualExit = await owned.exit;
      expect(actualExit).toEqual({ code: 0, signal: null });
      expect(result).toEqual({ stopped: [owned.pid], failed: [] });
    } finally {
      await cleanOwnedChild(owned);
    }
  });

  posixIt(
    "CP100-DR10: sends KILL only to an owned TERM-resistant child and records asynchronous exit",
    async () => {
      vi.restoreAllMocks();
      const owned = await startOwnedTui(
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        "kill-escalates",
      );
      let killIssued = false;
      let observeExit = false;
      const controller: ProcessController = {
        kill(pid, signal) {
          expect(pid).toBe(owned.pid);
          if (signal === 0) {
            if (killIssued && !observeExit) {
              return true; // Model kill(0) still seeing the PID before async reap.
            }
            if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
              throw Object.assign(new Error("gone"), { code: "ESRCH" });
            }
            return process.kill(pid, 0);
          }
          if (signal === "SIGKILL") {
            killIssued = true;
          }
          return process.kill(pid, signal);
        },
      };

      try {
        const result = await terminateLocalTuiProcesses({
          processes: [{ pid: owned.pid, command: owned.command, startTime: owned.startTime }],
          controller,
          graceMs: 0,
        });
        expect(result).toEqual({ stopped: [], failed: [owned.pid] });
        observeExit = true;
        const actualExit = await owned.exit;
        expect(actualExit).toEqual({ code: null, signal: "SIGKILL" });
      } finally {
        observeExit = true;
        await cleanOwnedChild(owned);
      }
    },
  );
});
