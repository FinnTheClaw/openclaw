import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  media: vi.fn(),
  placement: vi.fn(),
  progress: vi.fn(),
  resources: vi.fn(),
  backend: vi.fn(),
}));
vi.mock("./attempt-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attempt-setup.js")>()),
  resolveAttemptWorkspaceSandbox: mocks.workspace,
}));
vi.mock("./prompt-image-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt-image-preparation.js")>()),
  prepareEmbeddedAttemptPromptExecution: mocks.media,
}));
vi.mock("../../session-placement-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session-placement-admission.js")>()),
  resolveSessionPlacementSandbox: mocks.placement,
}));
vi.mock("../../progress-card-system-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../progress-card-system-prompt.js")>()),
  appendProgressCardSystemPrompt: mocks.progress,
}));
vi.mock("../../session-placement-skill-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session-placement-skill-resources.js")>()),
  resolveSessionSkillResourceSnapshot: mocks.resources,
}));
vi.mock("./backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend.js")>()),
  runEmbeddedAttemptWithBackend: mocks.backend,
}));
vi.mock("../../tools/gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tools/gateway-caller-context.js")>()),
  createAdmittedGatewayToolCallerIdentity: () => ({}),
  withGatewayToolCallerIdentity: (_identity: unknown, run: () => unknown) => run(),
}));

import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

beforeEach(() => {
  mocks.workspace.mockReset().mockResolvedValue({
    sessionAgentId: "main",
    effectiveFsWorkspaceOnly: false,
    effectiveWorkspace: "/tmp/work",
    sandbox: undefined,
  });
  mocks.media
    .mockReset()
    .mockResolvedValue({ images: undefined, imageOrder: undefined, media: undefined });
  mocks.placement.mockReset().mockResolvedValue(undefined);
  mocks.progress.mockReset().mockResolvedValue(undefined);
  mocks.resources.mockReset().mockReturnValue(undefined);
  mocks.backend.mockReset().mockResolvedValue({ terminal: { kind: "ok" } });
});
afterEach(() => vi.clearAllMocks());

function fixture(options: { plugin?: boolean; admitted?: boolean; abortError?: Error } = {}) {
  const close = vi.fn();
  const set = vi.fn();
  const clear = vi.fn();
  const params = {
    runId: "checkpoint90",
    agentId: "main",
    prompt: "hello",
    config: {},
    ...(options.admitted === false ? {} : { admittedRunContext: {} }),
  };
  const runtime = {
    agentId: "main",
    sessionId: "session",
    sessionKey: "session",
    sessionFile: "/tmp/session",
    workspaceDir: "/tmp/work",
    agentDir: "/tmp/agent",
    prompt: "hello",
    model: { id: "fixture", provider: "fixture", api: "openai-responses", contextWindow: 8192 },
    provider: "fixture",
    modelId: "fixture",
    requestedModelId: "fixture",
    fallbackActive: false,
    fallbackReason: null,
    authProfileIdSource: "auto",
    initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    fastMode: false,
    toolResultFormat: "markdown",
    skipPreparedUserTurnMessage: false,
    apiKeyInfo: null,
    runtimeAuthActive: false,
    captureRuntimeArtifact: false,
  };
  const control = {
    lifecycleGeneration: "test",
    pluginHarnessOwnsTransport: options.plugin ?? true,
    createAttemptControls: vi.fn(() => ({
      abortSignal: new AbortController().signal,
      onAttemptDeadlineChanged: vi.fn(),
      onAttemptTimeout: vi.fn(),
      onAttemptAbort: vi.fn(),
      close,
    })),
    onToolOutcome: vi.fn(),
    isTurnTainted: () => false,
    allocateToolOutcomeOrdinal: () => 1,
    onToolStreamBoundary: vi.fn(),
    onRunProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAgentEvent: vi.fn(),
    onUserMessagePersisted: vi.fn(),
    onUserMessagePersistenceInvalidated: vi.fn(),
    getPostCompactionAbortError: () => options.abortError,
    setPostCompactionAbortController: set,
    clearPostCompactionAbortController: clear,
  };
  const input = {
    params,
    runtime,
    control,
    transcriptOwnership: { kind: "runtime-target" },
    runStartedAtMs: Date.now(),
    bootstrapPromptWarningSignaturesSeen: [],
    suppressNextUserMessagePersistence: false,
    beforeAgentFinalizeRevisionAttempts: 0,
    maxBeforeAgentFinalizeRevisions: 0,
  } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0];
  return { input, set, clear, close, control };
}

async function expectCleanFailure(
  input: Parameters<typeof dispatchEmbeddedRunAttempt>[0],
  set: ReturnType<typeof vi.fn>,
  clear: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>,
  message: string,
) {
  await expect(dispatchEmbeddedRunAttempt(input)).rejects.toThrow(message);
  expect(set).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
  expect(clear.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
  expect(close.mock.calls.length).toBeLessThanOrEqual(1);
}

describe("checkpoint 90 attempt controller cleanup", () => {
  it("workspace-prep-reject", async () => {
    mocks.workspace.mockRejectedValueOnce(new Error("workspace failure"));
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "workspace failure");
    expect(f.control.createAttemptControls).not.toHaveBeenCalled();
  });
  it("prompt-media-prep-reject", async () => {
    mocks.media.mockRejectedValueOnce(new Error("media failure"));
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "media failure");
  });
  it("placement-prep-reject", async () => {
    mocks.placement.mockRejectedValueOnce(new Error("placement failure"));
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "placement failure");
  });
  it("progress-prompt-reject", async () => {
    mocks.progress.mockRejectedValueOnce(new Error("progress failure"));
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "progress failure");
  });
  it("skill-resource-reject", async () => {
    mocks.resources.mockImplementationOnce(() => {
      throw new Error("skill failure");
    });
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "skill failure");
  });
  it("missing-admission-context", async () => {
    const f = fixture({ admitted: false });
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "without an admitted run context");
  });
  it("backend-reject", async () => {
    mocks.backend.mockRejectedValueOnce(new Error("backend failure"));
    const f = fixture();
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "backend failure");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("backend-success", async () => {
    const f = fixture();
    await expect(dispatchEmbeddedRunAttempt(f.input)).resolves.toMatchObject({
      rawAttempt: { terminal: { kind: "ok" } },
    });
    expect(f.set).toHaveBeenCalledOnce();
    expect(f.clear).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("aborted-next-attempt", async () => {
    const f = fixture({ abortError: new Error("cancelled") });
    await expectCleanFailure(f.input, f.set, f.clear, f.close, "cancelled");
    expect(f.close).toHaveBeenCalledOnce();
    const next = fixture();
    await expect(dispatchEmbeddedRunAttempt(next.input)).resolves.toBeDefined();
    expect(next.clear).toHaveBeenCalledOnce();
  });
  it("repeated-prep-failures-no-stale-controller", async () => {
    for (let index = 0; index < 3; index += 1) {
      mocks.workspace.mockRejectedValueOnce(new Error("workspace failure"));
      const f = fixture();
      await expectCleanFailure(f.input, f.set, f.clear, f.close, "workspace failure");
    }
  });
});
