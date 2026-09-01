import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-readonly.js";
import { parseC02EvaluationSession, type C02Evaluation } from "./governor-c02-evaluation.js";
import {
  createC02EvaluationRestartMarkers,
  createGovernorC02EvaluationScope,
} from "./governor-c02-local-evaluator.js";

function evaluation(
  family: "A" | "B" | "C" | "D" | "E" | "F",
  nonce: string,
  caseNumber = "001",
): C02Evaluation {
  const parsed = parseC02EvaluationSession(`c02-eval:C02-${family}-${caseNumber}:${nonce}`);
  if (!parsed) {
    throw new Error("expected evaluation");
  }
  return parsed;
}

function run(key: string): GovernorAgentLoopRunInput {
  return Object.freeze({
    runId: "run-1",
    sessionKey: key,
    sessionId: "session-1",
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    prompt: "C02 evaluation",
    now: 10,
  });
}

function scope(
  item: C02Evaluation,
  markers = createC02EvaluationRestartMarkers(),
): GovernorAgentLoopRunScope {
  return createGovernorC02EvaluationScope({
    run: run(`c02-eval:${item.caseId}:${item.requestNonce}`),
    evaluation: item,
    restartMarkers: markers,
  });
}

function markerPaths(stateDir: string, item: C02Evaluation) {
  const directory = path.join(stateDir, "governor", "c02-eval-restarts");
  const base = `${item.caseId.toLowerCase()}-${item.family.toLowerCase()}-${item.requestNonce}`;
  return {
    directory,
    pending: path.join(directory, `${base}.pending.json`),
    consumed: path.join(directory, `${base}.consumed.json`),
  };
}

function writeRawPendingMarker(stateDir: string, item: C02Evaluation, payload: unknown): void {
  const paths = markerPaths(stateDir, item);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pending, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
}

async function complete(
  scope: GovernorAgentLoopRunScope,
  toolName: string,
  args: unknown,
  now: number,
) {
  const decision = scope.beforeTool({
    toolCallId: `${toolName}-${now}`,
    toolName,
    args,
    tool: undefined,
    now,
  });
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow") {
    throw new Error("expected allowed action");
  }
  await scope.afterTool({
    ticket: decision.ticket,
    toolCallId: `${toolName}-${now}`,
    toolName,
    result: "not retained",
    isError: false,
    now: now + 1,
  });
}

describe("C02 local evaluator", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c02-evaluator-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("preserves A ordered completion", async () => {
    const item = evaluation("A", "111111111111111111111111");
    const value = scope(item);
    await complete(value, "read", { path: item.alphaPath }, 11);
    await complete(value, "read", { path: item.betaPath }, 13);
    await complete(value, "exec", { command: "/usr/bin/python3 -c 'print(3)'" }, 15);
    expect(value.afterTurn({ assistantText: "", toolCallCount: 1, now: 17 })).toEqual({
      kind: "complete",
    });
    expect(() => value.assertTerminal()).not.toThrow();
    value.dispose();
  });

  it("preserves B's one-time redundant-action pressure", async () => {
    const item = evaluation("B", "222222222222222222222222");
    const value = scope(item);
    await complete(value, "read", { path: item.alphaPath }, 11);
    expect(value.afterTurn({ assistantText: "", toolCallCount: 1, now: 13 })).toEqual({
      kind: "continue",
      message:
        "Continue with the eligible action. For 222222222222222222222222, call observation A again now even though it completed.",
    });
    expect(
      value.beforeTool({
        toolCallId: "again",
        toolName: "read",
        args: { path: item.alphaPath },
        tool: undefined,
        now: 14,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_REDUNDANT_ACTION" });
    expect(value.afterTurn({ assistantText: "", toolCallCount: 0, now: 15 })).toEqual({
      kind: "continue",
      message: "Continue with the eligible action.",
    });
    value.dispose();
  });

  it("preserves C's stable early and redundant denials", async () => {
    const item = evaluation("C", "333333333333333333333333");
    const value = scope(item);
    expect(
      value.beforeTool({
        toolCallId: "early",
        toolName: "read",
        args: { path: item.betaPath },
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_ACTION_NOT_ELIGIBLE" });
    await complete(value, "read", { path: item.alphaPath }, 12);
    expect(
      value.beforeTool({
        toolCallId: "duplicate",
        toolName: "read",
        args: { path: item.alphaPath },
        tool: undefined,
        now: 14,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_REDUNDANT_ACTION" });
    value.dispose();
  });

  it("preserves D retry behavior when a required tool fails", async () => {
    const item = evaluation("D", "444444444444444444444444");
    const value = scope(item);
    const failed = value.beforeTool({
      toolCallId: "alpha-failed",
      toolName: "read",
      args: { path: item.alphaPath },
      tool: undefined,
      now: 11,
    });
    expect(failed.kind).toBe("allow");
    await value.afterTool({
      ...(failed.kind === "allow" ? { ticket: failed.ticket } : {}),
      toolCallId: "alpha-failed",
      toolName: "read",
      result: "not retained",
      isError: true,
      now: 12,
    });
    await complete(value, "read", { path: item.alphaPath }, 13);
    value.dispose();
  });

  it("preserves E fixture isolation", () => {
    const first = evaluation("E", "555555555555555555555555");
    const second = evaluation("E", "666666666666666666666666", "002");
    expect(first.alphaPath).not.toBe(second.alphaPath);
    expect(first.betaPath).not.toBe(second.betaPath);
    expect(first.stableSessionId).not.toBe(second.stableSessionId);
  });

  it("preserves F with one strict beta-complete marker and one resume", async () => {
    const item = evaluation("F", "777777777777777777777777");
    const first = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    await complete(first, "read", { path: item.alphaPath }, 11);
    await complete(first, "read", { path: item.betaPath }, 13);
    expect(first.disposition).toBe("checkpoint_pending");
    expect(first.afterTurn({ assistantText: "", toolCallCount: 1, now: 15 })).toEqual({
      kind: "interrupt",
      reasonCode: "C02_RESTART_REQUIRED",
    });
    expect(
      first.beforeTool({
        toolCallId: "stale",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 16,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_RESTART_REQUIRED" });
    first.dispose();

    const resumed = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    await complete(resumed, "exec", { command: "/usr/bin/python3 -c 'print(3)'" }, 17);
    expect(resumed.afterTurn({ assistantText: "", toolCallCount: 1, now: 19 })).toEqual({
      kind: "complete",
    });
    resumed.dispose();

    const replay = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    expect(replay.disposition).toBe("checkpoint_pending");
    replay.dispose();
  });

  it("allows only one concurrent F scope to claim the restart marker", async () => {
    const item = evaluation("F", "888888888888888888888888");
    const first = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    const second = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    await complete(first, "read", { path: item.alphaPath }, 11);
    await complete(second, "read", { path: item.alphaPath }, 12);
    const firstBeta = first.beforeTool({
      toolCallId: "first-beta",
      toolName: "read",
      args: { path: item.betaPath },
      tool: undefined,
      now: 13,
    });
    const secondBeta = second.beforeTool({
      toolCallId: "second-beta",
      toolName: "read",
      args: { path: item.betaPath },
      tool: undefined,
      now: 14,
    });
    expect(firstBeta.kind).toBe("allow");
    expect(secondBeta.kind).toBe("allow");
    await first.afterTool({
      ...(firstBeta.kind === "allow" ? { ticket: firstBeta.ticket } : {}),
      toolCallId: "first-beta",
      toolName: "read",
      result: "not retained",
      isError: false,
      now: 15,
    });
    expect(
      second.afterTool({
        ...(secondBeta.kind === "allow" ? { ticket: secondBeta.ticket } : {}),
        toolCallId: "second-beta",
        toolName: "read",
        result: "not retained",
        isError: false,
        now: 16,
      }),
    ).toBeUndefined();
    expect(second.disposition).toBe("checkpoint_pending");
    expect(second.afterTurn({ assistantText: "", toolCallCount: 1, now: 17 })).toEqual({
      kind: "interrupt",
      reasonCode: "C02_RESTART_REQUIRED",
    });
    const resumed = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    expect(
      resumed.beforeTool({
        toolCallId: "aggregate",
        toolName: "exec",
        args: { command: "/usr/bin/python3 -c 'print(3)'" },
        tool: undefined,
        now: 18,
      }),
    ).toMatchObject({ kind: "allow" });
    first.dispose();
    second.dispose();
    resumed.dispose();
  });

  it.each([
    {
      name: "wrong family",
      payload: (item: C02Evaluation) => ({
        kind: "c02-eval-restart",
        phase: "beta-complete",
        caseId: item.caseId,
        family: "A",
        requestNonce: item.requestNonce,
      }),
    },
    {
      name: "wrong nonce",
      payload: (item: C02Evaluation) => ({
        kind: "c02-eval-restart",
        phase: "beta-complete",
        caseId: item.caseId,
        family: "F",
        requestNonce: "999999999999999999999999",
      }),
    },
    {
      name: "stale phase",
      payload: (item: C02Evaluation) => ({
        kind: "c02-eval-restart",
        phase: "alpha-complete",
        caseId: item.caseId,
        family: "F",
        requestNonce: item.requestNonce,
      }),
    },
    { name: "malformed JSON", payload: () => "not-json" },
  ])("fails closed for a $name marker", ({ payload }) => {
    const item = evaluation("F", "aaaaaaaaaaaaaaaaaaaaaaaa");
    const paths = markerPaths(stateDir, item);
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    if (payload === "not-json") {
      fs.writeFileSync(paths.pending, payload, { encoding: "utf8", mode: 0o600 });
    } else {
      writeRawPendingMarker(stateDir, item, payload(item));
    }
    const value = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    expect(value.disposition).toBe("checkpoint_pending");
    value.dispose();
  });

  it("fails closed for a symlink marker and rejects a duplicate arm", () => {
    const item = evaluation("F", "bbbbbbbbbbbbbbbbbbbbbbbb");
    const paths = markerPaths(stateDir, item);
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const target = path.join(stateDir, "marker-target.json");
    fs.writeFileSync(target, "{}", "utf8");
    fs.symlinkSync(target, paths.pending);
    const blocked = scope(item, createC02EvaluationRestartMarkers({ stateDir }));
    expect(blocked.disposition).toBe("checkpoint_pending");
    blocked.dispose();

    fs.unlinkSync(paths.pending);
    const markers = createC02EvaluationRestartMarkers({ stateDir });
    expect(markers.arm(item, 0)).toBe(true);
    expect(markers.arm(item, 0)).toBe(false);
  });
});
