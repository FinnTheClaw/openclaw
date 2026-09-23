import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import {
  persistClawInstallRecord,
  readClawInstallRecord,
  updateClawInstallRecordStatus,
} from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

const provenanceFault = vi.hoisted(() => ({ once: false }));
vi.mock("../state/agent-provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/agent-provenance.js")>();
  return {
    ...actual,
    recordAgentProvenance: (...args: Parameters<typeof actual.recordAgentProvenance>) => {
      if (provenanceFault.once) {
        provenanceFault.once = false;
        throw new Error("injected provenance write failure");
      }
      return actual.recordAgentProvenance(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  provenanceFault.once = false;
  closeOpenClawStateDatabaseForTest();
});

async function makeFixture() {
  const root = tempDirs.make("checkpoint90-claw-");
  const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
  let config: OpenClawConfig = {};
  const dependencies = {
    env: stateEnv(root),
    consentPlanIntegrity: plan.planIntegrity,
    seedPackageBootstrap: async () => undefined,
    createWorkspaceFiles: async () => [],
    installPackages: async () => [],
    installMcpServers: async () => [],
    installCronJobs: async () => [],
  } satisfies Parameters<typeof applyClawAddPlan>[1];
  const commit = async (transform: (config: OpenClawConfig) => OpenClawConfig) => {
    config = transform(config);
  };
  return {
    root,
    plan,
    dependencies,
    commit,
    getConfig: () => config,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

describe("checkpoint 90 truthful Claw config commit", () => {
  it("successful-new-agent-write", async () => {
    const f = await makeFixture();
    const result = await applyClawAddPlan(f.plan, { ...f.dependencies, commitConfig: f.commit });
    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(f.getConfig().agents?.entries?.worker).toBeDefined();
  });

  it("write-failure-after-transform", async () => {
    const f = await makeFixture();
    const result = await applyClawAddPlan(f.plan, {
      ...f.dependencies,
      commitConfig: async (transform) => {
        transform(f.getConfig());
        throw new Error("disk write failed");
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "config_commit_failed", message: "disk write failed" },
    });
    expect(f.getConfig().agents?.entries?.worker).toBeUndefined();
  });

  it("retry-then-write-success", async () => {
    const f = await makeFixture();
    const failed = await applyClawAddPlan(f.plan, {
      ...f.dependencies,
      commitConfig: async (transform) => {
        transform(f.getConfig());
        throw new Error("disk write failed");
      },
    });
    expect(failed.configCommitted).toBe(false);
    const succeeded = await applyClawAddPlan(f.plan, { ...f.dependencies, commitConfig: f.commit });
    expect(succeeded).toMatchObject({ status: "complete", configCommitted: true });
    expect(f.getConfig().agents?.entries?.worker).toBeDefined();
  });

  it("retry-exhausted", async () => {
    const f = await makeFixture();
    for (let index = 0; index < 2; index += 1) {
      const result = await applyClawAddPlan(f.plan, {
        ...f.dependencies,
        commitConfig: async (transform) => {
          transform(f.getConfig());
          throw new Error("disk write failed");
        },
      });
      expect(result).toMatchObject({ status: "partial", configCommitted: false });
    }
    expect(f.getConfig().agents?.entries?.worker).toBeUndefined();
  });

  it("preexisting-same-agent-no-op", async () => {
    const f = await makeFixture();
    const { id: _id, ...entry } = f.plan.agent.config;
    f.setConfig({ agents: { entries: { worker: entry } } });
    const result = await applyClawAddPlan(f.plan, { ...f.dependencies, commitConfig: f.commit });
    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(f.getConfig().agents?.entries?.worker).toEqual(entry);
  });

  it("legacy-replacement-write-failure", async () => {
    const f = await makeFixture();
    const oldPlan = {
      ...f.plan,
      planIntegrity: "sha256:legacy-plan",
      agent: {
        ...f.plan.agent,
        config: { ...f.plan.agent.config, tools: { profile: "coding" as const } },
      },
    };
    const { id: _id, ...entry } = oldPlan.agent.config;
    f.setConfig({ agents: { entries: { worker: entry } } });
    persistClawInstallRecord(oldPlan, {
      env: f.dependencies.env,
      status: "workspace_ready",
      nowMs: 1,
    });
    openOpenClawStateDatabase({ env: f.dependencies.env })
      .db.prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const record = readClawInstallRecord("worker", { env: f.dependencies.env });
    if (!record) {
      throw new Error("expected legacy record");
    }
    const result = await applyClawAddPlan(f.plan, {
      ...f.dependencies,
      consentPlanIntegrity: oldPlan.planIntegrity,
      resumePlan: oldPlan,
      resumeRecord: record,
      commitConfig: async (transform) => {
        transform(f.getConfig());
        throw new Error("replacement write failed");
      },
    });
    expect(result).toMatchObject({ status: "partial", configCommitted: false });
    expect(f.getConfig().agents?.entries?.worker).toEqual(entry);
  });

  it("collision-before-transform", async () => {
    const f = await makeFixture();
    f.setConfig({ agents: { entries: { worker: { workspace: "/other/workspace" } } } });
    const result = await applyClawAddPlan(f.plan, { ...f.dependencies, commitConfig: f.commit });
    expect(result).toMatchObject({ status: "partial", configCommitted: false });
    expect(f.getConfig().agents?.entries?.worker).toEqual({ workspace: "/other/workspace" });
  });

  it("provenance-failure-after-write", async () => {
    const f = await makeFixture();
    provenanceFault.once = true;
    const result = await applyClawAddPlan(f.plan, { ...f.dependencies, commitConfig: f.commit });
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { code: "provenance_failed", message: "injected provenance write failure" },
    });
    expect(f.getConfig().agents?.entries?.worker).toBeDefined();
  });

  it("status-mark-failure-after-write", async () => {
    const f = await makeFixture();
    const result = await applyClawAddPlan(f.plan, {
      ...f.dependencies,
      commitConfig: f.commit,
      updateRecord: (agentId, status, options) => {
        if (status === "config_committed") {
          throw new Error("injected status write failure");
        }
        return updateClawInstallRecordStatus(agentId, status, options);
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { code: "config_commit_failed", message: "injected status write failure" },
    });
  });

  it("resume-record-write-failure-after-config-write", async () => {
    const f = await makeFixture();
    const legacyPlan = { ...f.plan, planIntegrity: "sha256:legacy-plan" };
    persistClawInstallRecord(legacyPlan, {
      env: f.dependencies.env,
      status: "workspace_ready",
      nowMs: 1,
    });
    openOpenClawStateDatabase({ env: f.dependencies.env })
      .db.prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const record = readClawInstallRecord("worker", { env: f.dependencies.env });
    if (!record) {
      throw new Error("expected legacy record");
    }
    let calls = 0;
    const result = await applyClawAddPlan(f.plan, {
      ...f.dependencies,
      consentPlanIntegrity: legacyPlan.planIntegrity,
      resumePlan: legacyPlan,
      resumeRecord: record,
      commitConfig: f.commit,
      persistRecord: (...args) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("injected resume record failure");
        }
        return persistClawInstallRecord(...args);
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { code: "config_commit_failed", message: "injected resume record failure" },
    });
    expect(f.getConfig().agents?.entries?.worker).toBeDefined();
  });
});
