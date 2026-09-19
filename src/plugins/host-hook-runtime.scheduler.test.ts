import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  cleanupPluginSessionSchedulerJobs,
  clearPluginHostRuntimeState,
  deletePluginSessionSchedulerJob,
  getPluginSessionSchedulerJobGeneration,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry.js";

const pluginId = "scheduler-cleanup-replacement";
const jobId = "recurring-job";
const sessionKey = "agent:main:main";

afterEach(() => {
  clearPluginHostRuntimeState({ pluginId });
});

it.each(["record", "map"] as const)(
  "preserves a replacement scheduler %s while an older cleanup is pending",
  async (replacement) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const previousRegistry = createEmptyPluginRegistry();
    const replacementRegistry = createEmptyPluginRegistry();
    const replacementCleanup = vi.fn();
    registerPluginSessionSchedulerJob({
      pluginId,
      ownerRegistry: previousRegistry,
      job: {
        id: jobId,
        sessionKey,
        kind: "session-turn",
        cleanup() {
          entered.resolve();
          return release.promise;
        },
      },
    });
    const previousGeneration = getPluginSessionSchedulerJobGeneration({ pluginId, jobId });
    const cleanup = cleanupPluginSessionSchedulerJobs({
      pluginId,
      reason: "restart",
      records: [],
      cleanupOwnerRegistry: previousRegistry,
    });
    try {
      await entered.promise;
      if (replacement === "map") {
        deletePluginSessionSchedulerJob({
          pluginId,
          jobId,
          expectedGeneration: previousGeneration,
        });
      }
      const replacementJobId = replacement === "map" ? "new-recurring-job" : jobId;
      registerPluginSessionSchedulerJob({
        pluginId,
        ownerRegistry: replacementRegistry,
        job: {
          id: replacementJobId,
          sessionKey,
          kind: "session-turn",
          cleanup: replacementCleanup,
        },
      });
      const replacementGeneration = getPluginSessionSchedulerJobGeneration({
        pluginId,
        jobId: replacementJobId,
      });
      expect(replacementGeneration).not.toBe(previousGeneration);
      release.resolve();

      await expect(cleanup).resolves.toEqual([]);
      expect(getPluginSessionSchedulerJobGeneration({ pluginId, jobId: replacementJobId })).toBe(
        replacementGeneration,
      );
      expect(replacementCleanup).not.toHaveBeenCalled();

      await expect(
        cleanupPluginSessionSchedulerJobs({
          pluginId,
          reason: "disable",
          cleanupOwnerRegistry: replacementRegistry,
        }),
      ).resolves.toEqual([]);
      expect(replacementCleanup).toHaveBeenCalledOnce();
      expect(
        getPluginSessionSchedulerJobGeneration({ pluginId, jobId: replacementJobId }),
      ).toBeUndefined();
    } finally {
      release.resolve();
      await cleanup;
    }
  },
);
