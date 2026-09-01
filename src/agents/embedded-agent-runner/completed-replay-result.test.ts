import { describe, expect, it } from "vitest";
import { createEmbeddedCompletedReplayResult } from "./completed-replay-result.js";

const nonce = "e4f0498dff17b9daec258320";
const sessionId = `c02-eval-c02-b-002-${nonce}`;
const taskId = `c02-eval-session:C02-B-002:${nonce}`;

function result(completedC02ReplayTaskId?: string) {
  return createEmbeddedCompletedReplayResult({
    sessionId,
    startedAt: Date.now(),
    provider: "remote-llm",
    model: "moira/brain",
    completedC02ReplayTaskId,
  });
}

describe("createEmbeddedCompletedReplayResult", () => {
  it("makes a completed C02 replay visible with canonical metadata", () => {
    expect(result(taskId)).toMatchObject({
      payloads: [{ text: "C02_COMPLETE" }],
      meta: {
        terminalReplyKind: "text",
        livenessState: "completed",
        agentMeta: {
          governedReplay: {
            feature: "c02-simple-efficiency",
            version: "v1",
            sessionId,
            taskId,
            completedStage: 3,
            output: "C02_COMPLETE",
          },
        },
      },
    });
  });

  it("keeps noncanonical and unrelated completed replays unchanged", () => {
    expect(result(`c02-eval-session:C02-B-002:${"0".repeat(24)}`)).toMatchObject({
      meta: { terminalReplyKind: "silent-empty", livenessState: "working" },
    });
    expect(result("ordinary-completed-task")).toMatchObject({
      meta: { terminalReplyKind: "silent-empty", livenessState: "working" },
    });
  });
});
