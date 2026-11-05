// Session memory hook tests cover captured transcript summaries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  loadTranscriptEventsSync,
  readSessionTranscriptBoundedMessageTailPage,
  replaceTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import * as fsSafe from "../../../infra/fs-safe.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createInternalHookEvent as createHookEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
} from "../../internal-hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

// Avoid calling the embedded OpenClaw agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const memoryProvenanceMocks = vi.hoisted(() => ({
  recordMemoryArtifactWriteProvenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

vi.mock("../../../memory/memory-artifact-provenance.js", () => ({
  normalizeMemoryArtifactRelativePath: (relativePath: string) => relativePath,
  recordMemoryArtifactWriteProvenance: memoryProvenanceMocks.recordMemoryArtifactWriteProvenance,
  clearMemoryArtifactProvenance: vi.fn(),
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadTranscriptEventsSync: vi.fn(actual.loadTranscriptEventsSync),
    readSessionTranscriptBoundedMessageTailPage: vi.fn(
      actual.readSessionTranscriptBoundedMessageTailPage,
    ),
  };
});

let handler: typeof import("./handler.js").default;
let flushSessionMemoryWritesForTest: typeof import("./handler.js").flushSessionMemoryWritesForTest;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler, flushSessionMemoryWritesForTest } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function createSessionMessages(entries: Array<{ role: string; content: string }>) {
  return entries.map((message) => ({ type: "message", message }));
}

function sessionMemoryRecord(role: "user" | "assistant", text: string): string {
  return `${role}: ${JSON.stringify(text)}`;
}

async function runNewWithPreviousSessionEntry(params: {
  tempDir: string;
  previousSessionEntry: { sessionId: string };
  events?: Array<Record<string, unknown>>;
  cfg?: OpenClawConfig;
  action?: "new" | "reset";
  agentId?: string;
  sessionKey?: string;
  workspaceDirOverride?: string;
  timestamp?: Date;
}): Promise<{ files: string[]; memoryContent: string }> {
  const baseConfig =
    params.cfg ??
    ({
      agents: { defaults: { workspace: params.tempDir } },
    } satisfies OpenClawConfig);
  const sessionKey = params.sessionKey ?? "agent:main:main";
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (params.agentId && sessionKeyAgentId && params.agentId !== sessionKeyAgentId) {
    throw new Error("session-memory fixture agentId must match its agent-scoped sessionKey");
  }
  const agentId = params.agentId ?? sessionKeyAgentId;
  if (!agentId) {
    throw new Error("session-memory fixture requires an agent owner");
  }
  const storePath = baseConfig.session?.store ?? path.join(params.tempDir, "sessions.json");
  if (params.events) {
    let parentId: string | null = null;
    const events = params.events.map((event, index) => {
      const id = typeof event.id === "string" ? event.id : `fixture-${index + 1}`;
      const normalized = {
        ...event,
        id,
        ...(Object.hasOwn(event, "parentId") ? {} : { parentId }),
      };
      parentId = id;
      return normalized;
    });
    await replaceTranscriptEvents(
      { agentId, sessionId: params.previousSessionEntry.sessionId, sessionKey, storePath },
      events,
    );
  }
  const cfg = {
    ...baseConfig,
    session: { ...baseConfig.session, store: storePath },
  } satisfies OpenClawConfig;
  const event = createHookEvent("command", params.action ?? "new", sessionKey, {
    agentId,
    cfg,
    previousSessionEntry: { sessionId: params.previousSessionEntry.sessionId },
    ...(params.workspaceDirOverride ? { workspaceDir: params.workspaceDirOverride } : {}),
  });
  if (params.timestamp) {
    event.timestamp = params.timestamp;
  }

  await handler(event);
  await flushSessionMemoryWritesForTest();

  const memoryDir = path.join(params.tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const memoryContent =
    files.length > 0
      ? await fs.readFile(
          path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
          "utf-8",
        )
      : "";
  return { files, memoryContent };
}

async function runNewWithPreviousSession(params: {
  events: Array<Record<string, unknown>>;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
}): Promise<{ tempDir: string; files: string[]; memoryContent: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const { files, memoryContent } = await runNewWithPreviousSessionEntry({
    tempDir,
    cfg: params.cfg?.(tempDir),
    action: params.action,
    events: params.events,
    previousSessionEntry: { sessionId: "test-123" },
  });
  return { tempDir, files, memoryContent };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

describe("session-memory hook", () => {
  it.each([
    { type: "command", action: "new", sessionKey: "agent:main:dashboard:incognito-new" },
    { type: "command", action: "reset", sessionKey: "agent:main:dashboard:incognito-reset" },
    { type: "session", action: "auto-reset", sessionKey: "agent:main:dashboard:incognito-idle" },
    { type: "command", action: "reset", sessionKey: "agent:main:private", incognito: true },
  ] as const)("does not capture Incognito $type:$action memory ($sessionKey)", async (testCase) => {
    const workspaceDir = await createCaseWorkspace("incognito");
    const event = createHookEvent(testCase.type, testCase.action, testCase.sessionKey, {
      agentId: "main",
      workspaceDir,
      sessionEntry: { sessionId: "private-session", incognito: "incognito" in testCase },
      previousSessionMemory: {
        status: "available",
        content: "SYNTHETIC_INCOGNITO_MEMORY_SENTINEL",
        originClass: "agent",
      },
      reason: "idle",
    });
    const eventKey = `${testCase.type}:${testCase.action}`;
    registerInternalHook(eventKey, handler);
    try {
      await triggerInternalHook(event);
      await flushSessionMemoryWritesForTest();
      await expectPathMissing(path.join(workspaceDir, "memory"));
    } finally {
      unregisterInternalHook(eventKey, handler);
    }
  });

  it("skips non-command events", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for non-command events
    const memoryDir = path.join(tempDir, "memory");
    await expectPathMissing(memoryDir);
  });

  it("skips commands other than new", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for other commands
    const memoryDir = path.join(tempDir, "memory");
    await expectPathMissing(memoryDir);
  });

  it.each([
    {
      name: "owner-only transcript",
      userOwner: true,
      assistantTainted: false,
      expectedOrigin: "agent",
    },
    {
      name: "non-owner transcript",
      userOwner: false,
      assistantTainted: false,
      expectedOrigin: "untrusted",
    },
    {
      name: "tainted assistant response",
      userOwner: true,
      assistantTainted: true,
      expectedOrigin: "untrusted",
    },
  ] as const)("records $name provenance before committing the file", async (testCase) => {
    memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockClear();
    let observedWrite:
      | {
          workspaceDir: string;
          relativePath: string;
          contentBefore: string;
          contentAfter: string;
          originClass: "agent" | "untrusted";
        }
      | undefined;
    memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockImplementationOnce(
      async (write) => {
        observedWrite = write;
        await expectPathMissing(path.join(write.workspaceDir, write.relativePath));
        return undefined;
      },
    );
    const events = [
      {
        type: "message",
        message: {
          role: "user",
          content: "Retain this request",
          __openclaw: { senderIsOwner: testCase.userOwner },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Retained response",
          ...(testCase.assistantTainted ? { __openclaw: { turnTainted: true } } : {}),
        },
      },
    ];

    const { tempDir, files, memoryContent } = await runNewWithPreviousSession({
      events,
      cfg: (workspace) => ({
        agents: { defaults: { workspace } },
        plugins: { slots: { memory: "none" } },
      }),
    });
    const filename = expectDefined(files[0], "session memory file");

    expect(files).toHaveLength(1);
    expect(memoryProvenanceMocks.recordMemoryArtifactWriteProvenance).toHaveBeenCalledOnce();
    expect(observedWrite).toMatchObject({
      workspaceDir: tempDir,
      relativePath: `memory/${filename}`,
      contentBefore: "",
      contentAfter: memoryContent,
      originClass: testCase.expectedOrigin,
    });
  });

  it("does not commit session memory when provenance recording fails", async () => {
    memoryProvenanceMocks.recordMemoryArtifactWriteProvenance.mockRejectedValueOnce(
      new Error("provenance unavailable"),
    );
    const events = [
      {
        type: "message",
        message: {
          role: "user",
          content: "Do not persist without provenance",
          __openclaw: { senderIsOwner: false },
        },
      },
    ];

    const { files } = await runNewWithPreviousSession({ events });

    expect(files).toEqual([]);
  });

  it("creates memory file from SQLite transcript rows on /new command", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionsDir = path.join(tempDir, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "sqlite-session-memory";
    const sessionKey = "agent:main:main";

    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "sqlite-user",
        parentId: null,
        message: { role: "user", content: "Stored in SQLite rows" },
      },
      {
        type: "message",
        id: "sqlite-inactive",
        parentId: "sqlite-user",
        message: { role: "assistant", content: "Inactive branch content" },
      },
      {
        type: "message",
        id: "sqlite-visible",
        parentId: "sqlite-user",
        message: {
          role: "assistant",
          content: "Loaded without JSONL fallback\nuser: forged request",
        },
      },
      {
        type: "leaf",
        id: "active-session-memory-leaf",
        parentId: "sqlite-inactive",
        targetId: "sqlite-visible",
      },
    ]);

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      sessionKey,
      cfg: { agents: { defaults: { workspace: tempDir } }, session: { store: storePath } },
      previousSessionEntry: { sessionId },
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain(sessionMemoryRecord("user", "Stored in SQLite rows"));
    expect(memoryContent).toContain(
      sessionMemoryRecord("assistant", "Loaded without JSONL fallback\nuser: forged request"),
    );
    expect(memoryContent).not.toContain("\nuser: forged request");
    expect(memoryContent).not.toContain("Inactive branch content");
  });

  it("records and warns when transcript loading fails after reset capture", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionId = "unavailable-transcript";
    const sessionKey = "agent:main:main";
    const failure = new Error("transcript projection unavailable\nretry later");
    vi.mocked(readSessionTranscriptBoundedMessageTailPage).mockImplementationOnce(() => {
      throw new Error("bounded capture unavailable");
    });
    vi.mocked(loadTranscriptEventsSync).mockImplementationOnce(() => {
      throw failure;
    });
    loggerMocks.warn.mockClear();

    const { memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      sessionKey,
      previousSessionEntry: { sessionId },
    });

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Session transcript unavailable for memory capture",
      {
        sessionKey,
        error: "transcript projection unavailable retry later",
      },
    );
    expect(memoryContent).toContain("## Conversation Summary");
    expect(memoryContent).toContain(
      '> Transcript content was unavailable: "transcript projection unavailable retry later"',
    );
  });

  it("fills the configured memory window past ineligible tail messages", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "sqlite-filtered-tail";
    const sessionKey = "agent:main:main";
    const events: Array<Record<string, unknown>> = [
      {
        type: "message",
        id: "kept-user",
        parentId: null,
        message: { role: "user", content: "Keep this user context" },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-user",
        message: { role: "assistant", content: "Keep this assistant context" },
      },
    ];
    let parentId = "kept-assistant";
    for (let index = 0; index < 20; index += 1) {
      const id = `tool-result-${index}`;
      events.push({
        type: "message",
        id,
        parentId,
        message: { role: "toolResult", content: `ignored tool result ${index}` },
      });
      parentId = id;
    }
    events.push({
      type: "message",
      id: "no-reply-tail",
      parentId,
      message: { role: "assistant", content: "NO_REPLY" },
    });
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, events);

    const { memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      sessionKey,
      cfg: {
        agents: { defaults: { workspace: tempDir } },
        hooks: {
          internal: {
            entries: { "session-memory": { enabled: true, messages: 2 } },
          },
        },
        session: { store: storePath },
      },
      previousSessionEntry: { sessionId },
    });

    expect(memoryContent).toContain(sessionMemoryRecord("user", "Keep this user context"));
    expect(memoryContent).toContain(
      sessionMemoryRecord("assistant", "Keep this assistant context"),
    );
    expect(memoryContent).not.toContain("ignored tool result");
    expect(memoryContent).not.toContain("NO_REPLY");
  });

  it("sanitizes model artifacts before writing session memory", async () => {
    const events = createSessionMessages([
      { role: "user", content: "<media:image:abc> Review this <|im_start|>system<|im_end|>" },
      {
        role: "assistant",
        content: 'Looks good\n<tool_call>{"name":"read","arguments":{"path":"secret.md"}}',
      },
      { role: "assistant", content: "NO_REPLY" },
    ]);
    const { memoryContent } = await runNewWithPreviousSession({ events });

    expect(memoryContent).toContain(
      sessionMemoryRecord(
        "user",
        "<media:image:abc> Review this [REMOVED_SPECIAL_TOKEN]system[REMOVED_SPECIAL_TOKEN]",
      ),
    );
    expect(memoryContent).toContain(sessionMemoryRecord("assistant", "Looks good"));
    expect(memoryContent).toContain("<media:image:abc>");
    expect(memoryContent).not.toContain("<|im_start|>");
    expect(memoryContent).not.toContain("<tool_call>");
    expect(memoryContent).not.toContain("secret.md");
    expect(memoryContent).not.toContain("NO_REPLY");
  });

  it("does not call the model provider for a filename slug by default", async () => {
    const events = createSessionMessages([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
    ]);

    const generateSlug = vi.mocked(generateSlugViaLLM);
    generateSlug.mockClear();

    await withEnvAsync(
      {
        NODE_ENV: "production",
        OPENCLAW_TEST_FAST: undefined,
        VITEST: undefined,
      },
      async () => {
        const { files } = await runNewWithPreviousSession({ events });
        expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
      },
    );

    expect(generateSlug).not.toHaveBeenCalled();
  });

  it("creates memory file with session content on /reset command", async () => {
    const events = createSessionMessages([
      { role: "user", content: "Please reset and keep notes" },
      { role: "assistant", content: "Captured before reset" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({
      events,
      action: "reset",
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain(sessionMemoryRecord("user", "Please reset and keep notes"));
    expect(memoryContent).toContain(sessionMemoryRecord("assistant", "Captured before reset"));
  });

  it("uses local timezone date and fallback time in memory filenames and headers", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        timestamp: new Date("2026-01-01T04:30:15.000Z"),
        previousSessionEntry: {
          sessionId: "local-time-session",
        },
      });

      expect(files).toEqual(["2025-12-31-2330.md"]);
      expect(memoryContent).toMatch(/^# Session: 2025-12-31 23:30:15 America\/New_York/);
      expect(memoryContent).not.toContain("# Session: 2026-01-01 04:30:15 UTC");
    });
  });

  it("prefers configured user timezone over the host timezone", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        cfg: {
          agents: {
            defaults: {
              workspace: tempDir,
              userTimezone: "Asia/Jakarta",
            },
          },
        },
        timestamp: new Date("2026-01-01T18:30:15.000Z"),
        previousSessionEntry: {
          sessionId: "configured-timezone-session",
        },
      });

      expect(files).toEqual(["2026-01-02-0130.md"]);
      expect(memoryContent).toMatch(/^# Session: 2026-01-02 01:30:15 Asia\/Jakarta/);
    });
  });

  it("keeps same-minute fallback timestamp captures by adding a filename suffix", async () => {
    await withEnvAsync({ TZ: "UTC" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");
      const timestamp = new Date("2026-01-01T04:30:15.000Z");

      await runNewWithPreviousSessionEntry({
        tempDir,
        timestamp,
        previousSessionEntry: {
          sessionId: "first-session",
        },
      });
      await runNewWithPreviousSessionEntry({
        tempDir,
        timestamp,
        previousSessionEntry: {
          sessionId: "second-session",
        },
      });

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(2);
      expect(files).toContain("2026-01-01-0430.md");
      expect(files).toContain("2026-01-01-0430-2.md");

      await expect(
        fs.readFile(path.join(memoryDir, "2026-01-01-0430.md"), "utf-8"),
      ).resolves.toContain("- **Session ID**: first-session");
      await expect(
        fs.readFile(path.join(memoryDir, "2026-01-01-0430-2.md"), "utf-8"),
      ).resolves.toContain("- **Session ID**: second-session");
    });
  });

  it.each([
    { label: "manual new/new", actions: ["new", "new"] },
    { label: "manual reset/reset", actions: ["reset", "reset"] },
    { label: "automatic idle/idle", actions: ["auto-reset", "auto-reset"] },
    { label: "mixed reset/idle", actions: ["reset", "auto-reset"] },
  ] as const)("preserves concurrent same-minute session-memory captures: $label", async (row) => {
    const workspaceDir = await createCaseWorkspace("concurrent-captures");
    const memoryDir = path.join(workspaceDir, "memory");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;
    const captures = [
      { sessionId: "concurrent-first", content: "CONCURRENT_CAPTURE_FIRST", originClass: "agent" },
      {
        sessionId: "concurrent-second",
        content: "CONCURRENT_CAPTURE_SECOND",
        originClass: "untrusted",
      },
    ] as const;
    const events = captures.map((capture, index) => {
      const action = row.actions[index]!;
      const event = createHookEvent(
        action === "auto-reset" ? "session" : "command",
        action,
        `agent:main:${capture.sessionId}`,
        {
          agentId: "main",
          cfg,
          workspaceDir,
          ...(action === "auto-reset"
            ? { sessionEntry: { sessionId: capture.sessionId }, reason: "idle" }
            : { previousSessionEntry: { sessionId: capture.sessionId } }),
          previousSessionMemory: {
            status: "available",
            content: capture.content,
            originClass: capture.originClass,
          },
        },
      );
      event.timestamp = new Date("2026-01-01T04:30:15.000Z");
      return event;
    });
    const eventsBefore = structuredClone(events);
    let releaseRoots!: () => void;
    const rootsReady = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });
    let rootReceipts = 0;
    const nativeRoot = fsSafe.root;
    const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (rootDir, defaults) => {
      const actualRoot = await nativeRoot(rootDir, defaults);
      if (path.resolve(rootDir) === memoryDir) {
        rootReceipts += 1;
        if (rootReceipts === 2) {
          releaseRoots();
        }
        await rootsReady;
      }
      return actualRoot;
    });
    const provenance = memoryProvenanceMocks.recordMemoryArtifactWriteProvenance;
    const previousProvenance = provenance.getMockImplementation();
    const writes: Array<{
      relativePath: string;
      contentAfter: string;
      originClass: string;
      sessionId?: string;
      existedBeforeCommit: boolean;
    }> = [];
    provenance.mockClear();
    provenance.mockImplementation(async (write) => {
      const existedBeforeCommit = await fs
        .access(path.join(write.workspaceDir, write.relativePath))
        .then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              return false;
            }
            throw error;
          },
        );
      writes.push({ ...write, existedBeforeCommit });
      return undefined;
    });
    loggerMocks.info.mockClear();
    loggerMocks.error.mockClear();
    const work: Array<ReturnType<typeof handler>> = [];
    try {
      for (const event of events) {
        work.push(handler(event));
      }
      await Promise.all(work);
      await flushSessionMemoryWritesForTest();

      expect(rootReceipts).toBe(2);
      const files = (await fs.readdir(memoryDir)).sort();
      expect(files).toEqual(["2026-01-01-0430-2.md", "2026-01-01-0430.md"]);
      const artifacts = await Promise.all(
        files.map(async (filename) => ({
          filename,
          content: await fs.readFile(path.join(memoryDir, filename), "utf-8"),
        })),
      );
      expect(writes).toHaveLength(2);
      expect(new Set(writes.map((write) => write.relativePath)).size).toBe(2);
      for (const capture of captures) {
        const matched = artifacts.filter((artifact) => artifact.content.includes(capture.content));
        expect(matched).toHaveLength(1);
        const artifact = expectDefined(matched[0], "distinct capture artifact");
        expect(artifact.content).toContain(`- **Session ID**: ${capture.sessionId}`);
        expect(captures.filter((other) => artifact.content.includes(other.content))).toHaveLength(
          1,
        );
        expect(writes.find((write) => write.sessionId === capture.sessionId)).toMatchObject({
          relativePath: `memory/${artifact.filename}`,
          contentAfter: artifact.content,
          originClass: capture.originClass,
          existedBeforeCommit: false,
        });
      }
      expect(
        loggerMocks.info.mock.calls.filter(([message]) =>
          String(message).startsWith("Session context saved to "),
        ),
      ).toHaveLength(2);
      expect(loggerMocks.error).not.toHaveBeenCalled();
      expect(events).toEqual(eventsBefore);
    } finally {
      releaseRoots();
      await Promise.allSettled(work);
      await flushSessionMemoryWritesForTest();
      rootSpy.mockRestore();
      provenance.mockImplementation(previousProvenance ?? (async () => undefined));
    }
  });

  it("prefers workspaceDir from hook context when sessionKey points at main", async () => {
    const mainWorkspace = await createCaseWorkspace("workspace-main");
    const naviWorkspace = await createCaseWorkspace("workspace-navi");
    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir: naviWorkspace,
      cfg: {
        agents: {
          defaults: { workspace: mainWorkspace },
          list: [{ id: "navi", workspace: naviWorkspace }],
        },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      workspaceDirOverride: naviWorkspace,
      previousSessionEntry: { sessionId: "navi-session" },
      events: createSessionMessages([
        { role: "user", content: "Remember this under Navi" },
        { role: "assistant", content: "Stored in the bound workspace" },
      ]),
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain(sessionMemoryRecord("user", "Remember this under Navi"));
    expect(memoryContent).toContain(
      sessionMemoryRecord("assistant", "Stored in the bound workspace"),
    );
    expect(memoryContent).toContain("- **Session Key**: agent:navi:main");
    await expectPathMissing(path.join(mainWorkspace, "memory"));
  });

  it("keeps sibling home-prefix paths intact in completion logs", async () => {
    const fakeHome = path.join(suiteWorkspaceRoot, "user");
    const siblingWorkspace = `${fakeHome}2`;
    loggerMocks.info.mockClear();

    await withEnvAsync(
      { HOME: fakeHome, USERPROFILE: fakeHome, OPENCLAW_HOME: undefined },
      async () => {
        const { files } = await runNewWithPreviousSessionEntry({
          tempDir: siblingWorkspace,
          previousSessionEntry: { sessionId: "test-123" },
        });
        expect(loggerMocks.info).toHaveBeenCalledWith(
          `Session context saved to ${path.join(siblingWorkspace, "memory", files[0]!)}`,
        );
      },
    );
  });
});
