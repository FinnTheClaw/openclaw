import { expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { activePlacement, sessionIdentity } from "./placement-suite.test-support.js";
import { finalizeWorkerTurnResult } from "./worker-turn-payload.js";
import { WORKER_CONTEXT_ENGINE_HOST } from "./worker-turn-prompt.js";
import * as transcriptTargetReader from "./worker-turn-transcript-target.js";

type Finalization = Parameters<typeof finalizeWorkerTurnResult>[0];

it.each([
  {
    title: "finalizes the direct context engine after accepting a device-folder turn",
    failed: false,
  },
  {
    title: "settles a failed device-folder turn without finalizing the context engine",
    failed: true,
  },
])("$title", async ({ failed }) => {
  const placement = activePlacement("synthetic-device-session", {
    workspaceBaseManifestRef: DEVICE_FOLDER_MANIFEST_REF,
  });
  const turnClaim: WorkerSessionTurnClaim = {
    sessionId: placement.sessionId,
    runId: "synthetic-run",
    claimId: "synthetic-claim",
    placementGeneration: placement.generation,
    owner: {
      kind: "worker",
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    },
  };
  const transcriptTarget = {
    ...sessionIdentity(placement.sessionId),
    storePath: "/synthetic/sessions.sqlite",
  };
  const turn = {
    ...transcriptTarget,
    sessionFile: "/synthetic/transcript.jsonl",
    workspaceDir: "/synthetic/device-folder",
    prompt: "A synthetic input.",
    runId: turnClaim.runId,
    timeoutMs: 1_000,
    config: {},
  } satisfies Finalization["turn"];
  const user = makeAgentUserMessage({ content: turn.prompt });
  const text = "The committed worker answer.";
  const answer = makeAgentAssistantMessage({ content: [{ type: "text", text }] });
  const base = { id: "user-entry", type: "message", message: user };
  const terminal = { id: "assistant-entry", type: "message", message: answer };
  const manager = {
    getBranch: () => [base, terminal],
    getLeafId: () => terminal.id,
    getEntry: (entryId: string) => [base, terminal].find((entry) => entry.id === entryId),
    getSessionTarget: () => undefined,
  } as unknown as SessionManager;
  // The real finalizer reads only these synthetic transcript facts.
  using open = vi.spyOn(SessionManager, "openAsync").mockResolvedValue(manager);
  using resolve = vi
    .spyOn(transcriptTargetReader, "resolveWorkerTurnTranscriptTarget")
    .mockReturnValue(transcriptTarget);

  const order: string[] = [];
  let released = false;
  const placements = {
    preparedWorkspaceResultPlacement: () => placement,
    prepareWorkspaceResultClaim: async () => void order.push("prepare"),
    validateWorkspaceResultClaim: () => !released,
    acceptWorkspaceResult: async () => void order.push("accept"),
    closeWorkerTurnToolState: async () => void order.push("close"),
    completeWorkspaceResultAndReleaseTurn: async () => {
      order.push("release");
      released = true;
      return placement;
    },
  } as unknown as Finalization["placements"];
  const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {
    order.push("afterTurn");
  });
  const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => {
    order.push("maintain");
    return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
  });
  const contextEngine: ContextEngine = {
    info: { id: "synthetic-device-engine", name: "Isolated test context engine" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    afterTurn,
    maintain,
  };
  const contextEngineTurn = {
    ...turn,
    contextEngine,
    contextEngineHostSupport: WORKER_CONTEXT_ENGINE_HOST,
    providerId: answer.provider,
    modelId: answer.model,
    warn: vi.fn(),
  } as unknown as Finalization["promptContext"]["contextEngineTurn"];
  const forbiddenWorkspaceIo = vi.fn(async () => {
    throw new Error("device-folder result must not use a filesystem or tunnel route");
  });
  const operation = finalizeWorkerTurnResult({
    placement,
    placements,
    turnClaim,
    workspace: { kind: "device-folder", deviceId: "synthetic-device", path: turn.workspaceDir },
    workspaceOperations: { run: forbiddenWorkspaceIo },
    tunnel: {
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      runWorkspaceCommand: forbiddenWorkspaceIo,
      syncWorkspace: forbiddenWorkspaceIo,
      reconcileWorkspace: forbiddenWorkspaceIo,
      quiesceWorkspace: forbiddenWorkspaceIo,
      stop: forbiddenWorkspaceIo,
    },
    transcriptTarget,
    publishAcceptedWorkspace: forbiddenWorkspaceIo,
    turn,
    processResult: {
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      stderr: "",
      stdout: JSON.stringify({
        ...(failed ? { status: "failed", reason: "turn-failed" } : { status: "completed" }),
        transcriptLeafId: terminal.id,
        transcriptNextSeq: 1,
      }),
    },
    assertInputAdmitted: () => {},
    modelRef: { provider: answer.provider, model: answer.model },
    baseLeafId: base.id,
    promptContext: {
      contextEngineTurn,
      history: [],
      prompt: turn.prompt,
      systemPromptText: "",
      systemPromptReport: undefined,
      runtimeContext: undefined,
      inHistorySystemUpdates: false,
      includeEmptySnapshots: false,
    },
    prepareReplyMedia: async (reply) => reply,
    takeFinishingOutcome: () => ({ error: "Synthetic worker turn failed" }),
    signal: new AbortController().signal,
    startedAt: 0,
    onReply: () => void order.push("reply"),
  });

  if (failed) {
    await expect(operation).rejects.toThrow("Synthetic worker turn failed");
    expect(order).toEqual(["prepare", "accept", "close", "release"]);
    expect(afterTurn).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  } else {
    await expect(operation).resolves.toMatchObject({ payloads: [{ text }] });
    expect(order).toEqual([
      "reply",
      "prepare",
      "accept",
      "afterTurn",
      "maintain",
      "close",
      "release",
    ]);
    expect(afterTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: placement.sessionId, messages: [user, answer] }),
    );
    expect(maintain).toHaveBeenCalledOnce();
  }
  expect(forbiddenWorkspaceIo).not.toHaveBeenCalled();
});
