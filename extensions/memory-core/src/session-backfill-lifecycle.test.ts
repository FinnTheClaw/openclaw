import { describe, expect, it } from "vitest";
import {
  readMemoryCoreWorkspaceEntries,
  SESSION_BACKFILL_REWIND_NAMESPACE,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import {
  recordSessionBackfillRewindBatch,
  rewindSessionBackfillIngestionState,
} from "./session-backfill-lifecycle.js";
import { readSessionIngestionState, writeSessionIngestionState } from "./session-ingestion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const harness = createMemoryCoreTestHarness();
const fileState = {
  mtimeMs: 1,
  size: 1,
  contentHash: "source",
  lineCount: 5,
  lastContentLine: 5,
};

function candidate(agentId: string) {
  return {
    contentIndex: 2,
    hash: `${agentId}-backfill`,
    scope: `${agentId}:session`,
    stateKey: `${agentId}:sessions/${agentId}/session`,
  };
}

async function workspaceWithAgents() {
  const workspaceDir = await harness.createTempWorkspace("rewind-owner-");
  const a = candidate("a");
  const b = candidate("b");
  await writeSessionIngestionState(workspaceDir, {
    version: 3,
    files: { [a.stateKey]: fileState, [b.stateKey]: fileState },
    seenMessages: {
      [a.scope]: [a.hash, "a-live"],
      [b.scope]: [b.hash, "b-live"],
    },
  });
  return { workspaceDir, a, b };
}

async function batches(workspaceDir: string) {
  return readMemoryCoreWorkspaceEntries<{
    version: 1;
    agentId?: string;
    candidates: ReturnType<typeof candidate>[];
  }>({ namespace: SESSION_BACKFILL_REWIND_NAMESPACE, workspaceDir });
}

async function legacyBatch(workspaceDir: string, key: string, candidates: unknown[]) {
  await writeMemoryCoreWorkspaceEntry({
    namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    workspaceDir,
    key,
    value: { version: 1, candidates },
  });
}

describe("session backfill rewind batch ownership", () => {
  it("stores distinct batch keys for identical candidate payloads from two agents", async () => {
    const workspaceDir = await harness.createTempWorkspace("rewind-key-");
    const payload = [candidate("a")];
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "a", candidates: payload });
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "b", candidates: payload });
    expect(new Set((await batches(workspaceDir)).map((entry) => entry.key)).size).toBe(2);
  });

  it("persists the explicit agent owner on new batches", async () => {
    const { workspaceDir, a } = await workspaceWithAgents();
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "a", candidates: [a] });
    expect((await batches(workspaceDir))[0]?.value.agentId).toBe("a");
  });

  it("rewinding B preserves A's cursor and seen hashes in a shared workspace", async () => {
    const { workspaceDir, a, b } = await workspaceWithAgents();
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "a", candidates: [a] });
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "b", candidates: [b] });
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    const state = await readSessionIngestionState(workspaceDir);
    expect({
      aLine: state.files[a.stateKey]?.lastContentLine,
      aSeen: state.seenMessages[a.scope],
      bLine: state.files[b.stateKey]?.lastContentLine,
      bSeen: state.seenMessages[b.scope],
    }).toEqual({ aLine: 5, aSeen: [a.hash, "a-live"], bLine: 2, bSeen: ["b-live"] });
  });

  it("deletes only B's owned batch after B rewind", async () => {
    const { workspaceDir, a, b } = await workspaceWithAgents();
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "a", candidates: [a] });
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "b", candidates: [b] });
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect((await batches(workspaceDir)).map((entry) => entry.value.agentId)).toEqual(["a"]);
  });

  it("can rewind A's retained batch after B has rolled back", async () => {
    const { workspaceDir, a, b } = await workspaceWithAgents();
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "a", candidates: [a] });
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "b", candidates: [b] });
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "a" })).toEqual({
      completeCoverage: false,
      rewoundCandidates: 1,
    });
  });

  it("rewinds an ownerless legacy batch proved to belong wholly to B", async () => {
    const { workspaceDir, b } = await workspaceWithAgents();
    await legacyBatch(workspaceDir, "legacy-b", [b]);
    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" })).toEqual({
      completeCoverage: false,
      rewoundCandidates: 1,
    });
  });

  it("leaves A's ownerless legacy batch untouched during B rewind", async () => {
    const { workspaceDir, a } = await workspaceWithAgents();
    await legacyBatch(workspaceDir, "legacy-a", [a]);
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect((await batches(workspaceDir)).map((entry) => entry.key)).toEqual(["legacy-a"]);
  });

  it("preserves an ownerless mixed-agent batch instead of partially consuming it", async () => {
    const { workspaceDir, a, b } = await workspaceWithAgents();
    await legacyBatch(workspaceDir, "legacy-mixed", [a, b]);
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect((await batches(workspaceDir)).map((entry) => entry.key)).toEqual(["legacy-mixed"]);
  });

  it("preserves a malformed ownerless batch rather than guessing ownership", async () => {
    const { workspaceDir, b } = await workspaceWithAgents();
    await legacyBatch(workspaceDir, "legacy-malformed", [{ ...b, stateKey: "" }]);
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect((await batches(workspaceDir)).map((entry) => entry.key)).toEqual(["legacy-malformed"]);
  });

  it("keeps later live-ingestion hashes while rewinding B's backfill hash", async () => {
    const { workspaceDir, b } = await workspaceWithAgents();
    await recordSessionBackfillRewindBatch({ workspaceDir, agentId: "b", candidates: [b] });
    await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "b" });
    expect((await readSessionIngestionState(workspaceDir)).seenMessages[b.scope]).toEqual([
      "b-live",
    ]);
  });
});
