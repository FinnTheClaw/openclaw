// Subagent spawn attachment tests cover strict base64 decoding, attachment name
// validation, materialization paths, and cleanup after spawn failures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { decodeStrictBase64 } from "./subagent-attachments.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let configOverride: Record<string, unknown> = {
  ...createSubagentSpawnTestConfig(),
};
let workspaceDirOverride = "";
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    updateSessionStoreMock,
    workspaceDir: workspaceDirOverride || os.tmpdir(),
  });
});

describe("decodeStrictBase64", () => {
  const maxBytes = 1024;

  it("valid base64 returns buffer with correct bytes", () => {
    const input = "hello world";
    const encoded = Buffer.from(input).toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result?.toString("utf8")).toBe(input);
  });

  it("empty string returns null", () => {
    expect(decodeStrictBase64("", maxBytes)).toBeNull();
  });

  it("bad padding (length % 4 !== 0) returns null", () => {
    expect(decodeStrictBase64("abc", maxBytes)).toBeNull();
  });

  it("non-base64 chars returns null", () => {
    expect(decodeStrictBase64("!@#$", maxBytes)).toBeNull();
  });

  it("whitespace-only returns null (empty after strip)", () => {
    expect(decodeStrictBase64("   ", maxBytes)).toBeNull();
  });

  it("pre-decode oversize guard: encoded string > maxEncodedBytes * 2 returns null", () => {
    // Pre-decode guard rejects obviously oversized payloads before allocating
    // the decoded buffer.
    const oversized = "A".repeat(2737);
    expect(decodeStrictBase64(oversized, maxBytes)).toBeNull();
  });

  it("decoded byteLength exceeds maxDecodedBytes returns null", () => {
    const bigBuf = Buffer.alloc(1025, 0x42);
    const encoded = bigBuf.toString("base64");
    expect(decodeStrictBase64(encoded, maxBytes)).toBeNull();
  });

  it("valid base64 at exact boundary returns Buffer", () => {
    const exactBuf = Buffer.alloc(1024, 0x41);
    const encoded = exactBuf.toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result?.byteLength).toBe(1024);
  });
});

describe("spawnSubagentDirect filename validation", () => {
  beforeEach(async () => {
    workspaceDirOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    updateSessionStoreMock.mockReset();
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    if (workspaceDirOverride) {
      fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
      workspaceDirOverride = "";
    }
    vi.unstubAllEnvs();
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  const validContent = Buffer.from("hello").toString("base64");

  async function spawnWithName(name: string) {
    const { spawnSubagentDirect } = subagentSpawnModule;
    return spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name, content: validContent, encoding: "base64" }],
      },
      ctx,
    );
  }

  it("name with / returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo/bar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await spawnWithName("..");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await spawnWithName(".manifest.json");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "file.txt", content: validContent, encoding: "base64" },
          { name: "file.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await spawnWithName("");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("snapshots a local staged-media path under an allowed root", async () => {
    const inboundDir = path.join(workspaceDirOverride, "media", "inbound");
    fs.mkdirSync(inboundDir, { recursive: true });
    const sourcePath = path.join(inboundDir, "photo.jpg");
    fs.writeFileSync(sourcePath, Buffer.from("real image bytes"));
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            allowLocalPaths: true,
            localPathRoots: [inboundDir],
            maxFiles: 50,
            maxFileBytes: 1024,
            maxTotalBytes: 4096,
          },
        },
      },
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "describe the image",
        attachments: [{ name: "photo.jpg", path: sourcePath, mimeType: "image/jpeg" }],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    expect(result.modelRoute).toBeUndefined();
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    const [attachmentId] = fs.readdirSync(attachmentsRoot);
    expect(fs.readFileSync(path.join(attachmentsRoot, attachmentId, "photo.jpg"), "utf8")).toBe(
      "real image bytes",
    );
  });

  it("rejects local attachment paths outside administrator-approved roots", async () => {
    const inboundDir = path.join(workspaceDirOverride, "media", "inbound");
    fs.mkdirSync(inboundDir, { recursive: true });
    const outsidePath = path.join(workspaceDirOverride, "outside.jpg");
    fs.writeFileSync(outsidePath, Buffer.from("outside"));
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            allowLocalPaths: true,
            localPathRoots: [inboundDir],
          },
        },
      },
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "describe the image",
        attachments: [{ name: "outside.jpg", path: outsidePath, mimeType: "image/jpeg" }],
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("attachments_local_path_outside_allowed_roots");
  });

  (process.platform === "win32" ? it.skip : it)(
    "rejects a symlink inside an allowed root when it resolves outside",
    async () => {
      const inboundDir = path.join(workspaceDirOverride, "media", "inbound");
      fs.mkdirSync(inboundDir, { recursive: true });
      const outsidePath = path.join(workspaceDirOverride, "outside.jpg");
      const symlinkPath = path.join(inboundDir, "linked.jpg");
      fs.writeFileSync(outsidePath, Buffer.from("outside"));
      fs.symlinkSync(outsidePath, symlinkPath);
      configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
        tools: {
          sessions_spawn: {
            attachments: {
              enabled: true,
              allowLocalPaths: true,
              localPathRoots: [inboundDir],
            },
          },
        },
      });

      const { spawnSubagentDirect } = subagentSpawnModule;
      const result = await spawnSubagentDirect(
        {
          task: "describe the image",
          attachments: [{ name: "linked.jpg", path: symlinkPath, mimeType: "image/jpeg" }],
        },
        ctx,
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("attachments_local_path_outside_allowed_roots");
    },
  );

  it("rejects attachments that provide both inline content and a local path", async () => {
    const inboundDir = path.join(workspaceDirOverride, "media", "inbound");
    fs.mkdirSync(inboundDir, { recursive: true });
    const sourcePath = path.join(inboundDir, "photo.jpg");
    fs.writeFileSync(sourcePath, Buffer.from("image"));
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            allowLocalPaths: true,
            localPathRoots: [inboundDir],
          },
        },
      },
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "describe the image",
        attachments: [
          {
            name: "photo.jpg",
            path: sourcePath,
            content: validContent,
            encoding: "base64",
            mimeType: "image/jpeg",
          },
        ],
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("attachments_exactly_one_source_required");
  });

  it("materializes attachments under explicit cwd when native subagent cwd is provided", async () => {
    const explicitWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-cwd-attachments-${process.pid}-${Date.now()}-`),
    );
    try {
      const { spawnSubagentDirect } = subagentSpawnModule;
      const result = await spawnSubagentDirect(
        {
          task: "test",
          cwd: explicitWorkspaceDir,
          attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
        },
        ctx,
      );

      expect(result.status).toBe("accepted");
      const explicitAttachmentsRoot = path.join(explicitWorkspaceDir, ".openclaw", "attachments");
      const targetAttachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
      expect(fs.existsSync(explicitAttachmentsRoot)).toBe(true);
      expect(fs.existsSync(targetAttachmentsRoot)).toBe(false);
    } finally {
      fs.rmSync(explicitWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("normalizes explicit cwd before materializing native subagent attachments", async () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-home-attachments-${process.pid}-${Date.now()}-`),
    );
    const expectedCwd = path.join(homeDir, "task-repo");
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      persistedStore = store;
      return store;
    });
    try {
      await withEnvAsync({ HOME: homeDir }, async () => {
        const { spawnSubagentDirect } = subagentSpawnModule;
        const result = await spawnSubagentDirect(
          {
            task: "test",
            cwd: "~/task-repo",
            attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
          },
          ctx,
        );

        expect(result.status).toBe("accepted");
        const attachmentsRoot = path.join(expectedCwd, ".openclaw", "attachments");
        expect(fs.existsSync(attachmentsRoot)).toBe(true);
        const childSessionKey = result.childSessionKey as string;
        expect(persistedStore?.[childSessionKey]?.spawnedCwd).toBe(expectedCwd);
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("removes materialized attachments when lineage patching fails", async () => {
    // Attachments are created before the child session lineage patch; failures
    // must delete both the child session and materialized files.
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      if (Object.values(store).some((entry) => typeof entry.spawnedBy === "string")) {
        throw new Error("lineage patch failed");
      }
      return store;
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("lineage patch failed");
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    const retainedDirs = fs.existsSync(attachmentsRoot)
      ? fs.readdirSync(attachmentsRoot).filter((entry) => !entry.startsWith("."))
      : [];
    expect(retainedDirs).toHaveLength(0);
    const deleteCall = calls.find((entry) => entry.method === "sessions.delete");
    const deleteParams = deleteCall?.params as
      | {
          key?: string;
          deleteTranscript?: boolean;
          emitLifecycleHooks?: boolean;
        }
      | undefined;
    expect(deleteParams?.key).toMatch(/^agent:main:subagent:/);
    expect(deleteParams?.deleteTranscript).toBe(true);
    expect(deleteParams?.emitLifecycleHooks).toBe(false);
  });
});
