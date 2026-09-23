import { describe, expect, it, vi } from "vitest";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
} from "./process-reaper.js";

const wrapperRoot = "/tmp/openclaw-state/acpx";
const wrapperPath = `${wrapperRoot}/codex-acp-wrapper.mjs`;
const command = `node ${wrapperPath}`;
const leasedCommand = `${command} --openclaw-acpx-lease-id lease-1 --openclaw-gateway-instance-id gateway-1`;
type Row = { pid: number; ppid: number; command: string; startIdentity?: string };
type Snapshot = Row[] | Error;
const root = (identity = "start-1"): Row => ({
  pid: 81001,
  ppid: 1,
  command,
  startIdentity: identity,
});
const child = (identity = "child-1"): Row => ({
  pid: 81002,
  ppid: 81001,
  command: "node adapter-child.js",
  startIdentity: identity,
});
function setup(snapshots: Snapshot[]) {
  let next = 0;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const deps = {
    listProcesses: vi.fn(async () => {
      const snapshot = snapshots[Math.min(next, snapshots.length - 1)]!;
      next += 1;
      if (snapshot instanceof Error) {
        throw snapshot;
      }
      return snapshot;
    }),
    killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
    }),
    sleep: vi.fn(async () => {}),
    platform: "linux" as const,
  };
  return { deps, signals };
}
const cleanup = (deps: ReturnType<typeof setup>["deps"]) =>
  cleanupOpenClawOwnedAcpxProcessTree({
    rootPid: 81001,
    rootCommand: command,
    wrapperRoot,
    deps,
  });

describe("ACPX process start identity before signaling", () => {
  it("ACPX-01 changed-start PID before SIGTERM sends no signal", async () => {
    const { deps, signals } = setup([[root()], [root("replacement")]]);
    expect((await cleanup(deps)).terminatedPids).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("ACPX-02 changed-start PID after SIGTERM prevents SIGKILL", async () => {
    const { deps, signals } = setup([[root()], [root()], [root("replacement")]]);
    await cleanup(deps);
    expect(signals).toEqual([{ pid: 81001, signal: "SIGTERM" }]);
  });

  it("ACPX-03 exited PID after SIGTERM receives no SIGKILL", async () => {
    const { deps, signals } = setup([[root()], [root()], []]);
    await cleanup(deps);
    expect(signals).toEqual([{ pid: 81001, signal: "SIGTERM" }]);
  });

  it("ACPX-04 same PID and start still live gets TERM then KILL", async () => {
    const { deps, signals } = setup([[root()]]);
    await cleanup(deps);
    expect(signals).toEqual([
      { pid: 81001, signal: "SIGTERM" },
      { pid: 81001, signal: "SIGKILL" },
    ]);
  });

  it("ACPX-05 process-list failure before TERM sends no signal", async () => {
    const { deps, signals } = setup([[root()], new Error("ps unavailable")]);
    expect((await cleanup(deps)).terminatedPids).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("ACPX-06 process-list failure before KILL prevents force signal", async () => {
    const { deps, signals } = setup([[root()], [root()], new Error("ps unavailable")]);
    await cleanup(deps);
    expect(signals).toEqual([{ pid: 81001, signal: "SIGTERM" }]);
  });

  it("ACPX-07 equal command and PID with changed start does not force-kill", async () => {
    const { deps, signals } = setup([[root()], [root()], [root("same-command-new-start")]]);
    await cleanup(deps);
    expect(signals).toEqual([{ pid: 81001, signal: "SIGTERM" }]);

    // Darwin's ps lstart is only second-resolution; even a stable-looking
    // snapshot cannot justify a delayed force-kill there.
    const mac = setup([[root()]]);
    await cleanup({ ...mac.deps, platform: "darwin" });
    expect(mac.signals).toEqual([{ pid: 81001, signal: "SIGTERM" }]);
  });

  it("ACPX-08 changed child identity is skipped without cross-kill", async () => {
    const { deps, signals } = setup([
      [root(), child()],
      [root(), child("replacement-child")],
      [root(), child("replacement-child")],
      [root(), child("replacement-child")],
    ]);
    await cleanup(deps);
    expect(signals).toEqual([
      { pid: 81001, signal: "SIGTERM" },
      { pid: 81001, signal: "SIGKILL" },
    ]);
  });

  it("ACPX-09 descendants TERM child-first and KILL only identical survivors", async () => {
    const second: Row = {
      pid: 81003,
      ppid: 81001,
      command: "node another-child.js",
      startIdentity: "second",
    };
    const initial = [root(), child(), second];
    const { deps, signals } = setup([
      initial,
      initial,
      initial,
      initial,
      [root(), second],
      [root(), second],
      [root(), second],
    ]);
    await cleanup(deps);
    const termPids = signals.filter((item) => item.signal === "SIGTERM").map((item) => item.pid);
    expect(termPids).toHaveLength(3);
    expect(termPids.slice(0, 2).toSorted()).toEqual([81002, 81003]);
    expect(termPids[2]).toBe(81001);
    expect(signals.filter((item) => item.signal === "SIGKILL").map((item) => item.pid)).toEqual([
      81003, 81001,
    ]);
  });

  it("ACPX-10 pending lease gateway mismatch sends no signal", async () => {
    const foreign: Row = {
      pid: 81001,
      ppid: 1,
      command: leasedCommand.replace("gateway-1", "gateway-foreign"),
      startIdentity: "lease-start",
    };
    const { deps, signals } = setup([[foreign]]);
    const result = await cleanupOpenClawOwnedAcpxPendingLease({
      leaseId: "lease-1",
      gatewayInstanceId: "gateway-1",
      wrapperRoot,
      wrapperPath,
      deps,
    });
    expect(result.skippedReason).toBe("missing-root");
    expect(signals).toEqual([]);
  });
});
