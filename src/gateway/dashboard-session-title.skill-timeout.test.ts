import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  load: vi.fn(),
  patch: vi.fn(),
  prepareSkills: vi.fn(),
  readTranscript: vi.fn(),
}));

// mock-isolation: Exercise ordinary title orchestration without model, storage, or skill workers.
vi.mock("../agents/utility-model.js", () => ({ resolveUtilityModelRefForAgent: () => undefined }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: mocks.generate,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: mocks.load,
}));
vi.mock("../skills/discovery/chat-commands.js", () => ({
  prepareSkillCommandsForWorkspace: mocks.prepareSkills,
}));
vi.mock("./session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscriptAsync: mocks.readTranscript,
}));

import { maybeGenerateDashboardSessionTitle } from "./dashboard-session-title.js";

it("persists an ordinary title when optional skill command discovery times out", async () => {
  const entry: SessionEntry = { sessionId: "title-test", updatedAt: 1 };
  const firstMessage = "Plan the release";
  mocks.load.mockResolvedValue(entry);
  mocks.prepareSkills.mockRejectedValueOnce(
    new WorkerTaskError("worker task timed out", "timeout"),
  );
  mocks.readTranscript.mockResolvedValue({
    firstUserMessage: firstMessage,
    lastMessagePreview: null,
  });
  mocks.generate.mockResolvedValue("Release planning");
  const applyPatch = vi.fn((update: (current: SessionEntry) => Partial<SessionEntry> | null) =>
    update(entry),
  );
  mocks.patch.mockImplementation(async (_scope, update) => ({ ...entry, ...applyPatch(update) }));

  await expect(
    maybeGenerateDashboardSessionTitle({
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
      agentId: "main",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:dashboard:chat-1",
      storePath: "/tmp/openclaw-title-test/sessions.json",
      userMessage: "Review the plan next",
    }),
  ).resolves.toBe(true);

  expect(mocks.prepareSkills).toHaveBeenCalledOnce();
  expect(mocks.generate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ userMessage: firstMessage }),
  );
  expect(applyPatch).toHaveReturnedWith({ displayName: "Release planning" });
});
