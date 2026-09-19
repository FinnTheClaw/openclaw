import { describe, expect, it } from "vitest";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream-status.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent, resetToolStream } from "./tool-stream.ts";

describe("approval lifecycle replay ownership", () => {
  it("applies a current approval and its later resolution", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(
      host,
      agentEvent("run-1", 5, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-1",
        toolCallId: "tool-1",
      }),
    );
    expect(host.waitingApprovalStatuses?.has("approval-1")).toBe(true);
    handleAgentEvent(
      host,
      agentEvent("run-1", 6, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );
    expect(host.waitingApprovalStatuses?.size).toBe(0);
    expect(host.waitingApprovalResolvedIds?.has("approval-1")).toBe(true);
  });

  it("does not revive a resolved approval when older history activity is replayed", () => {
    const host = createHost({ chatRunId: "run-1" });
    const waiting = agentEvent("run-1", 5, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
    });
    handleAgentEvent(host, waiting);
    handleAgentEvent(
      host,
      agentEvent("run-1", 6, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );
    handleAgentEvent(host, waiting);
    expect(host.waitingApprovalStatuses?.size).toBe(0);
    expect(host.waitingApprovalResolvedIds?.has("approval-1")).toBe(true);
  });

  it("keeps another approval pending while rejecting an older resolved-approval replay", () => {
    const host = createHost({ chatRunId: "run-1" });
    const waiting = agentEvent("run-1", 5, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
    });
    handleAgentEvent(host, waiting);
    handleAgentEvent(
      host,
      agentEvent("run-1", 6, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-2",
        toolCallId: "tool-2",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 7, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );
    handleAgentEvent(host, waiting);
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
  });

  it("does not revive a resolved approval after transient tool reset", () => {
    const host = createHost({ chatRunId: "run-1" });
    const waiting = agentEvent("run-1", 5, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
    });
    handleAgentEvent(host, waiting);
    handleAgentEvent(
      host,
      agentEvent("run-1", 6, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );
    resetToolStream(host);
    handleAgentEvent(host, waiting);
    expect(host.waitingApprovalStatuses?.size).toBe(0);
    expect(host.waitingApprovalResolvedIds?.has("approval-1")).toBe(true);
  });

  it("rehydrates a still-pending approval after transient tool reset", () => {
    const host = createHost({ chatRunId: "run-1" });
    const waiting = agentEvent("run-1", 5, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
    });
    handleAgentEvent(host, waiting);
    resetToolStream(host);
    handleAgentEvent(host, waiting);
    expect(host.waitingApprovalStatuses?.get("approval-1")).toMatchObject({
      runId: "run-1",
      toolCallId: "tool-1",
    });
  });

  it("reclaims resolved replay state only when the snapshot retires its tombstone", () => {
    const host = createHost({ chatRunId: "run-1" });
    const waiting = agentEvent("run-1", 5, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
    });
    handleAgentEvent(host, waiting);
    handleAgentEvent(
      host,
      agentEvent("run-1", 6, "lifecycle", {
        phase: "approval-resolved",
        approvalId: "approval-1",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 7, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-2",
      }),
    );
    handleAgentEvent(host, waiting);
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
    expect(host.activityEventSeqById?.size).toBe(2);
    const approval = (id: string) => ({
      id,
      kind: "exec" as const,
      request: { command: "echo test", sessionKey: "main", runId: "run-1" },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    reconcileWaitingApprovalsFromSnapshot(host, [approval("approval-1"), approval("approval-2")]);
    expect(host.activityEventSeqById?.size).toBe(2);
    expect(host.waitingApprovalResolvedIds?.has("approval-1")).toBe(true);
    reconcileWaitingApprovalsFromSnapshot(host, [approval("approval-2")]);
    expect(host.activityEventSeqById?.size).toBe(1);
    expect(host.waitingApprovalResolvedIds?.has("approval-1")).toBe(false);
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
  });

  it("accepts older-sequence events for independently owned approvals", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(
      host,
      agentEvent("run-1", 20, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-1",
        toolCallId: "tool-1",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 10, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-2",
        toolCallId: "tool-2",
      }),
    );
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-1", "approval-2"]);
    handleAgentEvent(
      host,
      agentEvent("run-2", 1, "lifecycle", {
        phase: "waiting-approval",
        approvalId: "approval-1",
        toolCallId: "tool-other",
      }),
    );
    expect(host.waitingApprovalStatuses?.get("approval-1")?.runId).toBe("run-2");
  });
});
