import { expect, it, vi } from "vitest";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../../config/sessions/activity-summary.js";
import * as transcriptWatermark from "../../config/sessions/session-transcript-watermark.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSessionActivitySummaries } from "../session-activity-summaries.js";
import { recapRpc } from "../session-activity-summaries.test-support.js";
import * as sessionPreparation from "../session-sharing-preparation.js";
import * as sessionStore from "../session-utils-store-lookup.js";
import * as activeRuns from "./session-active-runs.js";

it("keeps healthy saved recaps when one freshness read times out", async () => {
  const storePath = "/tmp/recap-freshness-fixture/sessions.json";
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: { defaults: { utilityModel: "test/utility" } },
  };
  const targets = ["delayed", "healthy"].map((label) => ({
    key: `agent:main:recap-${label}`,
    agentId: "main",
  }));
  const watermark = { generation: "fixture-generation", maxSeq: 1 };
  const entryFor = (key: string): SessionEntry => ({
    sessionId: key,
    updatedAt: 1,
    activitySummary: {
      version: 1,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      text: `Saved recap for ${key}.`,
      updatedAt: 1,
      sessionId: key,
      ...watermark,
      leafEntryId: "message-1",
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
    },
  });
  // Hold only recap freshness, not keyed row preparation. No actual stores or model runs.
  using matchingRows = vi
    .spyOn(sessionPreparation, "prepareSessionMutationFacts")
    .mockImplementation(async ({ sessionKey: key, agentId }) => {
      const storageTarget = { agentId, canonicalKey: key, storePath };
      return {
        storageTarget,
        bindCreation() {},
        prepareRead: () => undefined,
        readCurrent: () => ({
          target: { ...storageTarget, storeKey: key, storeKeys: [key], entry: entryFor(key) },
          membership: new Set<string>(),
        }),
        release() {},
      };
    });
  using entryRead = vi
    .spyOn(sessionStore, "withGatewaySessionStoreTarget")
    .mockImplementation(async ({ agentId, key }, consume) =>
      consume(
        {
          agentId: agentId ?? "main",
          canonicalKey: key,
          storePath,
          storeKeys: [key],
          store: { [key]: entryFor(key) },
        },
        new Map(),
        () => {},
        [],
      ),
    );
  using active = vi
    .spyOn(activeRuns, "resolveVisibleActiveSessionRunState")
    .mockReturnValue({ active: true });
  using freshness = vi
    .spyOn(transcriptWatermark, "readSessionTranscriptWatermarkAsync")
    .mockImplementation(async ({ sessionKey }) => {
      if (sessionKey === targets[0]!.key) {
        throw new WorkerTaskError("worker task timed out", "timeout");
      }
      return watermark;
    });
  const service = createSessionActivitySummaries({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    onChanged: () => {},
  });
  try {
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      sessionActivitySummaries: service,
    });
    const { invoke, respond } = recapRpc("sessions.activitySummary.ensure", context);
    await expect(invoke({ sessions: targets })).resolves.toBeUndefined();
    expect(matchingRows).toHaveBeenCalledTimes(2);
    expect(entryRead).toHaveBeenCalledTimes(2);
    expect(active).toHaveBeenCalled();
    expect(freshness).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      sessions: targets.map((target, index) => ({
        ...target,
        activitySummary: {
          state: index === 0 ? "unavailable" : "current",
          canEnsure: true,
          text: entryFor(target.key).activitySummary!.text,
          updatedAt: 1,
        },
      })),
    });
  } finally {
    await service.dispose();
  }
});
