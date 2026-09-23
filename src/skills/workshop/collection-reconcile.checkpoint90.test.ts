import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { listWritableSkillCollection, reconcileSkillCollection } from "./collection-reconcile.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { applySkillProposal, proposeCreateSkill } from "./service.js";

const faults = vi.hoisted(() => ({
  cleanup: false,
  promotion: false,
  history: false,
  prune: false,
  snapshot: false,
  mutation: false,
  backup: false,
}));
vi.mock("./collection-rollback.js", async (original) => {
  const real = await original<typeof import("./collection-rollback.js")>();
  return {
    ...real,
    discardStagedSkillCollectionDrops: async (
      ...args: Parameters<typeof real.discardStagedSkillCollectionDrops>
    ) => {
      if (faults.cleanup) {
        throw new Error("injected cleanup failure");
      }
      return real.discardStagedSkillCollectionDrops(...args);
    },
  };
});
vi.mock("./collection-create-proposal.js", async (original) => {
  const real = await original<typeof import("./collection-create-proposal.js")>();
  return {
    ...real,
    promoteCollectionCreateProposal: async (
      ...args: Parameters<typeof real.promoteCollectionCreateProposal>
    ) => {
      if (faults.promotion) {
        throw new Error("injected promotion failure");
      }
      return real.promoteCollectionCreateProposal(...args);
    },
  };
});
vi.mock("./collection-review-state.js", async (original) => {
  const real = await original<typeof import("./collection-review-state.js")>();
  return {
    ...real,
    recordSkillCollectionReviewHistory: (
      ...args: Parameters<typeof real.recordSkillCollectionReviewHistory>
    ) => {
      if (faults.history) {
        throw new Error("injected history failure");
      }
      return real.recordSkillCollectionReviewHistory(...args);
    },
  };
});
vi.mock("./collection-paths.js", async (original) => {
  const real = await original<typeof import("./collection-paths.js")>();
  return {
    ...real,
    pruneOlderSkillCollectionBackups: async (
      ...args: Parameters<typeof real.pruneOlderSkillCollectionBackups>
    ) => {
      if (faults.prune) {
        throw new Error("injected prune failure");
      }
      return real.pruneOlderSkillCollectionBackups(...args);
    },
  };
});
vi.mock("../lifecycle/skill-change-hook.js", async (original) => {
  const real = await original<typeof import("../lifecycle/skill-change-hook.js")>();
  return {
    ...real,
    hasCommittedSkillChangeHooks: () => true,
    snapshotCommittedSkillArtifactBestEffort: async (
      ...args: Parameters<typeof real.snapshotCommittedSkillArtifactBestEffort>
    ) => {
      if (faults.snapshot) {
        throw new Error("injected snapshot failure");
      }
      return real.snapshotCommittedSkillArtifactBestEffort(...args);
    },
  };
});
vi.mock("./collection-byte-limits.js", async (original) => {
  const real = await original<typeof import("./collection-byte-limits.js")>();
  return {
    ...real,
    assertCollectionMutationCurrent: async (
      ...args: Parameters<typeof real.assertCollectionMutationCurrent>
    ) => {
      if (faults.mutation) {
        throw new Error("injected mutation failure");
      }
      return real.assertCollectionMutationCurrent(...args);
    },
  };
});
vi.mock("./collection-backup.js", async (original) => {
  const real = await original<typeof import("./collection-backup.js")>();
  return {
    ...real,
    createCollectionBackup: async (...args: Parameters<typeof real.createCollectionBackup>) => {
      if (faults.backup) {
        throw new Error("injected backup failure");
      }
      return real.createCollectionBackup(...args);
    },
  };
});

let testState: OpenClawTestState;
let workspaceDir: string;
beforeEach(async () => {
  for (const key of Object.keys(faults) as Array<keyof typeof faults>) {
    faults[key] = false;
  }
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "checkpoint90-collection-state-",
  });
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint90-collection-"));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function receipt() {
  const skills = listWritableSkillCollection(workspaceDir, { env: testState.env });
  return {
    readSkillHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.name, sha256Hex(await fs.readFile(skill.filePath, "utf8"))] as const,
        ),
      ),
    ),
    readSkillTreeHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.name, await readSkillProposalTargetTreeSha256(skill.baseDir)] as const,
        ),
      ),
    ),
  };
}
async function ownedSkill(name: string) {
  const proposal = await proposeCreateSkill({
    workspaceDir,
    env: testState.env,
    name,
    description: "Existing procedure",
    content: "# Existing\n",
  });
  await applySkillProposal({
    workspaceDir,
    env: testState.env,
    proposalId: proposal.record.id,
    expectedRevisionHash: proposal.revisionHash,
  });
}
function writePlan(name = "new-skill") {
  return [
    { action: "write" as const, name, description: "New procedure", content: "# New procedure\n" },
  ];
}
async function create(name = "new-skill") {
  return reconcileSkillCollection({
    workspaceDir,
    env: testState.env,
    readSkillHashes: new Map(),
    readSkillTreeHashes: new Map(),
    plan: writePlan(name),
  });
}
async function drop(name = "old-skill") {
  return reconcileSkillCollection({
    workspaceDir,
    env: testState.env,
    ...(await receipt()),
    plan: [{ action: "drop", name, reason: "obsolete" }],
  });
}
async function exists(name: string) {
  return fs.access(path.join(workspaceDir, "skills", name, "SKILL.md")).then(
    () => true,
    () => false,
  );
}

describe("ST07 committed collection status", () => {
  it("01 normal write reports committed disk state", async () => {
    const result = await create();
    expect(result.written).toEqual(["new-skill"]);
    expect(result.postCommitWarnings).toBeUndefined();
    expect(await exists("new-skill")).toBe(true);
  });
  it("02 normal drop reports removed disk state", async () => {
    await ownedSkill("old-skill");
    const result = await drop();
    expect(result.dropped).toEqual([{ name: "old-skill", reason: "obsolete" }]);
    expect(await exists("old-skill")).toBe(false);
  });
  it("03 cleanup failure reports committed drop and warning", async () => {
    await ownedSkill("old-skill");
    faults.cleanup = true;
    const result = await drop();
    expect(await exists("old-skill")).toBe(false);
    expect(result.postCommitWarnings?.join(" ")).toContain("staged-drop cleanup");
  });
  it("04 proposal promotion failure reports committed write", async () => {
    faults.promotion = true;
    const result = await create();
    expect(await exists("new-skill")).toBe(true);
    expect(result.postCommitWarnings?.join(" ")).toContain("proposal promotion");
  });
  it("05 history failure reports committed write", async () => {
    faults.history = true;
    const result = await create();
    expect(await exists("new-skill")).toBe(true);
    expect(result.postCommitWarnings?.join(" ")).toContain("history");
  });
  it("06 prune failure reports committed write", async () => {
    faults.prune = true;
    const result = await create();
    expect(await exists("new-skill")).toBe(true);
    expect(result.postCommitWarnings?.join(" ")).toContain("backup prune");
  });
  it("07 snapshot failure reports committed write", async () => {
    faults.snapshot = true;
    const result = await create();
    expect(await exists("new-skill")).toBe(true);
    expect(result.postCommitWarnings?.join(" ")).toContain("snapshot");
  });
  it("08 precommit mutation failure does not write", async () => {
    faults.mutation = true;
    await expect(create()).rejects.toThrow("injected mutation failure");
    expect(await exists("new-skill")).toBe(false);
  });
  it("09 precommit backup failure does not write", async () => {
    faults.backup = true;
    await expect(create()).rejects.toThrow("injected backup failure");
    expect(await exists("new-skill")).toBe(false);
  });
  it("10 postcommit failure does not invite blind duplicate retry", async () => {
    faults.history = true;
    const result = await create();
    expect(result.postCommitWarnings).toHaveLength(1);
    faults.history = false;
    await expect(create()).rejects.toThrow();
    expect(await exists("new-skill")).toBe(true);
  });
});
