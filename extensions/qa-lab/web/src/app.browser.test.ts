/* @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, RunnerSelection } from "./ui-types.js";

const httpMock = vi.hoisted(() => {
  class QaLabHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly payload: unknown,
    ) {
      super(message);
    }
  }
  return {
    getJson: vi.fn(),
    getJsonNoStore: vi.fn(),
    postJson: vi.fn(),
    QaLabHttpError,
  };
});

vi.mock("./http.js", () => httpMock);

import { createQaLabApp } from "./app.js";

const scenarios: Bootstrap["scenarios"] = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
    execution: { kind: "flow" },
  },
  {
    id: "browser-talk-start-stop",
    title: "Browser Talk start-stop",
    surface: "control-ui",
    objective: "test browser Talk",
    successCriteria: ["playwright pass"],
    execution: { kind: "playwright" },
  },
];

function createBootstrap(selection: RunnerSelection): Bootstrap {
  const selectedScenarioIds = selection.scenarioIds ?? scenarios.map((scenario) => scenario.id);
  return {
    baseUrl: "http://127.0.0.1:43124",
    controlUiEmbeddedUrl: null,
    controlUiUrl: null,
    defaults: {
      conversationId: "qa-operator",
      conversationKind: "direct",
      senderId: "qa-operator",
      senderName: "QA Operator",
    },
    kickoffTask: "Run QA",
    latestReport: null,
    runner: {
      artifacts: null,
      error: null,
      plan: {
        errors: [],
        exclusions: [],
        executionKinds: ["flow", "playwright"],
        explicitScenarioSelection: selection.scenarioIds !== null,
        profile: selection.profile,
        selectedScenarios: scenarios
          .filter((scenario) => selectedScenarioIds.includes(scenario.id))
          .map((scenario) => ({
            declaredChannel: null,
            effectiveChannel: scenario.execution?.kind === "flow" ? "qa-channel" : null,
            executionKind: scenario.execution?.kind ?? "flow",
            id: scenario.id,
            title: scenario.title,
          })),
        status: "ready",
      },
      selection,
      status: "idle",
    },
    runnerCatalog: {
      channels: ["buzz", "matrix", "telegram"],
      profiles: [
        { id: "smoke-ci", evidenceMode: "slim", channelDriver: "crabline", categoryIds: [] },
        { id: "all", evidenceMode: "full", channelDriver: "live", categoryIds: [] },
      ],
      status: "ready",
      real: [
        {
          input: "text",
          key: "openai/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          preferred: true,
          provider: "openai",
        },
      ],
    },
    scenarios,
  };
}

async function mountRunner(
  selection: RunnerSelection,
  snapshot: QaBusStateSnapshot = {
    conversations: [],
    cursor: 0,
    events: [],
    messages: [],
    threads: [],
  },
) {
  let bootstrap = createBootstrap(selection);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/bootstrap") {
      return bootstrap;
    }
    if (url === "/api/state") {
      return snapshot;
    }
    if (url === "/api/report") {
      return { report: null };
    }
    if (url === "/api/outcomes") {
      return { run: null };
    }
    if (url === "/api/capture/sessions") {
      return { sessions: [] };
    }
    if (url === "/api/capture/startup-status") {
      return {
        status: {
          gateway: { label: "Gateway", ok: true, url: "http://127.0.0.1:18789" },
          proxy: { label: "Proxy", ok: true, url: "http://127.0.0.1:7799" },
          qaLab: { label: "QA Lab", ok: true, url: bootstrap.baseUrl },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  httpMock.getJsonNoStore.mockResolvedValue({ version: "test" });
  httpMock.postJson.mockImplementation(async (url: string, body: unknown) => {
    if (url !== "/api/scenario/suite") {
      throw new Error(`unexpected POST ${url}`);
    }
    const nextSelection = body as RunnerSelection;
    bootstrap = createBootstrap(nextSelection);
    return { runner: { selection: nextSelection } };
  });
  const root = document.createElement("div");
  document.body.append(root);
  await createQaLabApp(root);
  return root;
}

function selectValue(root: HTMLElement, selector: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(selector);
  if (!select) {
    throw new Error(`missing select ${selector}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  const styles = document.createElement("style");
  styles.dataset.qaLabTestStyles = "true";
  styles.textContent = readFileSync(
    path.join(process.cwd(), "extensions/qa-lab/web/src/styles.css"),
    "utf8",
  );
  document.head.append(styles);
  httpMock.getJson.mockReset();
  httpMock.getJsonNoStore.mockReset();
  httpMock.postJson.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.querySelector("style[data-qa-lab-test-styles]")?.remove();
});

describe("QA Lab runner browser interactions", () => {
  it("labels every execution configuration select", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    const selects = [...root.querySelectorAll<HTMLSelectElement>(".config-field select")];

    expect(selects).toHaveLength(9);
    expect(selects.map((select) => select.labels?.[0]?.textContent?.trim())).toEqual([
      "Profile",
      "Provider lane",
      "Channel driver",
      "Execution channel",
      "Evidence mode",
      "Runtime pair",
      "Runtime-pair lane",
      "Primary model",
      "Alternate model",
    ]);
  });

  it("sends group conversation messages from the interactive chat composer", async () => {
    const root = await mountRunner(
      {
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        channel: null,
        channelDriver: "qa-channel",
        evidenceMode: "full",
        fastMode: false,
        primaryModel: "mock-openai/gpt-5.6-luna",
        profile: "all",
        providerMode: "mock-openai",
        runtimePair: null,
        runtimePairLane: null,
        scenarioIds: ["dm-chat-baseline"],
      },
      {
        conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
        cursor: 0,
        events: [],
        messages: [],
        threads: [
          {
            accountId: "default",
            conversationId: "qa-room",
            createdAt: 0,
            createdBy: "qa-operator",
            id: "owned-thread",
            title: "Owned thread",
          },
        ],
      },
    );
    httpMock.postJson.mockResolvedValue({ message: { id: "group-message" } });

    root.querySelector<HTMLButtonElement>("[data-thread-select='owned-thread']")?.click();
    selectValue(root, "#conversation-kind", "group");
    const conversationInput = root.querySelector<HTMLInputElement>("#conversation-id");
    if (!conversationInput) {
      throw new Error("missing group conversation input");
    }
    conversationInput.value = "qa-group";
    conversationInput.dispatchEvent(new Event("input", { bubbles: true }));
    const composer = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (!composer) {
      throw new Error("missing group message composer");
    }
    composer.value = "hello group";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-action='send']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/inbound/message",
      expect.objectContaining({
        accountId: "default",
        conversation: { id: "qa-group", kind: "group", title: "qa-group" },
        text: "hello group",
      }),
    );
    const submittedPayload = httpMock.postJson.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submittedPayload).not.toHaveProperty("threadId");
  });

  it("keeps scenario rows from collapsing inside the scrolling list", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    const scroll = root.querySelector<HTMLElement>(".scenario-scroll");
    const row = root.querySelector<HTMLElement>(".scenario-item");
    expect(scroll).not.toBeNull();
    expect(row).not.toBeNull();
    expect(getComputedStyle(scroll!).overflowY).toBe("auto");
    expect(getComputedStyle(row!).flexShrink).toBe("0");
  });

  it("submits live-provider and Crabline selections with non-flow scenarios", async () => {
    const root = await mountRunner({
      alternateModel: "openai/gpt-5.6-luna",
      channel: null,
      channelDriver: "crabline",
      evidenceMode: "full",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "live-frontier",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-action='select-all-scenarios']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    );
  });

  it("changes to real channels without changing the mock provider lane", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    expect(
      Array.from(
        root.querySelectorAll<HTMLSelectElement>("#execution-channel option"),
        (option) => option.value,
      ),
    ).toEqual(["", "buzz", "matrix", "telegram"]);
    selectValue(root, "#channel-driver", "live");
    selectValue(root, "#execution-channel", "telegram");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "live",
        channel: "telegram",
        providerMode: "mock-openai",
      }),
    );
  });

  it("submits profile, evidence, runtime-pair, lane, and channel controls", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    selectValue(root, "#execution-channel", "telegram");
    selectValue(root, "#evidence-mode", "slim");
    selectValue(root, "#runtime-pair", "openclaw,codex");
    selectValue(root, "#runtime-pair-lane", "core");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        channel: "telegram",
        channelDriver: "crabline",
        evidenceMode: "slim",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
        scenarioIds: null,
      }),
    );
  });

  it("renders server-resolved exclusions and errors from a rejected launch", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });
    httpMock.postJson.mockRejectedValueOnce(
      new httpMock.QaLabHttpError("selection rejected", 400, {
        plan: {
          errors: ["Explicit QA scenario selection is not runnable."],
          exclusions: [
            {
              executionKind: "flow",
              reasons: ["channel=telegram"],
              scenarioId: "dm-chat-baseline",
            },
          ],
          executionKinds: [],
          explicitScenarioSelection: true,
          profile: "all",
          selectedScenarios: [],
          status: "invalid",
        },
      }),
    );

    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#evidence-mode", "slim");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='run']")?.click();
    expect(root.textContent).not.toContain("Explicit QA scenario selection is not runnable");
    expect(root.textContent).not.toContain("Resolved plan:");
  });

  it("starts a dirty profile override without reusing the previous resolved plan", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='scenarios']")?.click();
    root
      .querySelector<HTMLInputElement>("[data-scenario-toggle-id='browser-talk-start-stop']")
      ?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        scenarioIds: ["browser-talk-start-stop"],
      }),
    );
  });

  it("disables launch when an explicit override becomes empty", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "qa-channel",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLInputElement>("[data-scenario-toggle-id='dm-chat-baseline']")?.click();
    const runButton = root.querySelector<HTMLButtonElement>("[data-action='run-suite']");
    expect(runButton?.disabled).toBe(true);
    expect(runButton?.textContent).toContain("Run 0 scenarios");
    runButton?.click();
    expect(httpMock.postJson).not.toHaveBeenCalled();
  });
});

type CaptureRaceKind = "sessions" | "startup" | "events" | "coverage" | "query";
type CaptureRaceTarget = "B" | "A-B-A" | "slow-timer" | "preset" | "timer-B";

function deferredCaptureResponse() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushCaptureRefresh() {
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
}

const captureSelection: RunnerSelection = {
  alternateModel: "mock-openai/gpt-5.6-luna-alt",
  channel: null,
  channelDriver: "qa-channel",
  evidenceMode: "full",
  fastMode: false,
  primaryModel: "mock-openai/gpt-5.6-luna",
  profile: "all",
  providerMode: "mock-openai",
  runtimePair: null,
  runtimePairLane: null,
  scenarioIds: ["dm-chat-baseline"],
};

describe("QA Lab capture refresh selection races", () => {
  it.each([
    ["late A events cannot replace B events", "events", "B", false],
    ["late A coverage cannot replace B coverage", "coverage", "B", false],
    ["late A query cannot replace B query", "query", "B", false],
    ["late A session list cannot reset B selection", "sessions", "B", false],
    ["late A startup probe cannot replace B events", "startup", "B", false],
    ["A-B-A rejects the first A events response", "events", "A-B-A", false],
    ["A-B-A rejects the first A coverage response", "coverage", "A-B-A", false],
    ["a 1.2s periodic response commits and polling resumes", "events", "slow-timer", true],
    ["preset change rejects rows from the old preset", "query", "preset", false],
    ["a timer refresh cannot overwrite a later B selection", "events", "timer-B", true],
  ] as const)(
    "%s",
    async (_name, kind: CaptureRaceKind, target: CaptureRaceTarget, useTimer: boolean) => {
      const root = await mountRunner(captureSelection);
      const fallback = httpMock.getJson.getMockImplementation();
      if (!fallback) {
        throw new Error("missing baseline request handler");
      }
      let armed = false;
      let delayed = false;
      let requestNumber = 0;
      const oldResponse = deferredCaptureResponse();
      const marker = (_sessionId: string, label: string) => ({
        events: [
          {
            id: 1,
            ts: 1,
            protocol: "https",
            direction: "outbound",
            kind: "request",
            flowId: label,
            host: label,
            provider: label,
            path: "/capture",
          },
        ],
      });
      const coverage = (sessionId: string, label: string) => ({
        coverage: {
          sessionId,
          totalEvents: label === "old-A" ? 111 : label === "B-current" ? 222 : 333,
          unlabeledEventCount: 0,
          providers: [{ value: label, count: 1 }],
          apis: [],
          models: [],
          hosts: [{ value: label, count: 1 }],
          localPeers: [],
        },
      });
      const sessions = {
        sessions: ["A", "B"].map((id) => ({
          id,
          startedAt: 1,
          mode: "proxy",
          sourceProcess: "test",
          eventCount: 1,
        })),
      };
      httpMock.getJson.mockImplementation((url: string) => {
        const sessionId = new URL(url, "http://qa.test").searchParams.get("sessionId") ?? "A";
        const label = sessionId === "B" ? "B-current" : requestNumber === 1 ? "old-A" : "A-current";
        const matching =
          (kind === "sessions" && url === "/api/capture/sessions") ||
          (kind === "startup" && url === "/api/capture/startup-status") ||
          (kind === "events" && url.startsWith("/api/capture/events?")) ||
          (kind === "coverage" && url.startsWith("/api/capture/coverage?")) ||
          (kind === "query" && url.startsWith("/api/capture/query?"));
        if (armed && !delayed && matching) {
          delayed = true;
          return oldResponse.promise;
        }
        if (url === "/api/capture/sessions") return Promise.resolve(sessions);
        if (url.startsWith("/api/capture/events?"))
          return Promise.resolve(marker(sessionId, label));
        if (url.startsWith("/api/capture/coverage?"))
          return Promise.resolve(coverage(sessionId, label));
        if (url.startsWith("/api/capture/query?")) {
          return Promise.resolve({
            rows: [
              { marker: label, preset: new URL(url, "http://qa.test").searchParams.get("preset") },
            ],
          });
        }
        return fallback(url);
      });

      root.querySelector<HTMLButtonElement>("[data-tab='capture']")?.click();
      root.querySelector<HTMLButtonElement>("[data-action='refresh']")?.click();
      await flushCaptureRefresh();
      root.querySelector<HTMLButtonElement>("#capture-controls-toggle")?.click();
      await flushCaptureRefresh();
      expect(root.querySelector("#capture-session")).not.toBeNull();
      selectValue(root, "#capture-preset", "double-sends");
      await flushCaptureRefresh();
      armed = true;
      requestNumber = 1;
      root.querySelector<HTMLButtonElement>("[data-action='refresh']")?.click();
      await flushCaptureRefresh();
      expect(delayed).toBe(true);

      requestNumber = 2;
      if (target === "slow-timer") {
        const sessionsBefore = httpMock.getJson.mock.calls.filter(
          ([url]) => url === "/api/capture/sessions",
        ).length;
        await vi.advanceTimersByTimeAsync(1_200);
        await flushCaptureRefresh();
        expect(
          httpMock.getJson.mock.calls.filter(([url]) => url === "/api/capture/sessions"),
        ).toHaveLength(sessionsBefore);
        oldResponse.resolve(marker("A", "old-A"));
        await flushCaptureRefresh();
        expect(root.querySelector(".capture-events-scroll")?.textContent).toContain("old-A");
        await vi.advanceTimersByTimeAsync(1_000);
        await flushCaptureRefresh();
        expect(root.querySelector(".capture-events-scroll")?.textContent).toContain("A-current");
        return;
      }
      if (target === "B" || target === "A-B-A" || target === "timer-B") {
        if (useTimer) {
          await vi.advanceTimersByTimeAsync(1_000);
          await flushCaptureRefresh();
        }
        selectValue(root, "#capture-session", "B");
      } else if (target === "preset") {
        selectValue(root, "#capture-preset", "retry-storms");
      } else {
        root.querySelector<HTMLButtonElement>("[data-action='refresh']")?.click();
      }
      await flushCaptureRefresh();
      if (target === "A-B-A") {
        requestNumber = 3;
        selectValue(root, "#capture-session", "A");
        await flushCaptureRefresh();
      }

      oldResponse.resolve(
        kind === "sessions"
          ? sessions
          : kind === "startup"
            ? { status: null }
            : kind === "events"
              ? marker("A", "old-A")
              : kind === "coverage"
                ? coverage("A", "old-A")
                : { rows: [{ marker: "old-A", preset: "double-sends" }] },
      );
      await flushCaptureRefresh();
      const expected = target === "B" || target === "timer-B" ? "B-current" : "A-current";
      const eventText = root.querySelector(".capture-events-scroll")?.textContent ?? "";
      expect(eventText).toContain(expected);
      expect(eventText).not.toContain("old-A");
      if (kind === "coverage") {
        root.querySelector<HTMLButtonElement>("#capture-summary-toggle")?.click();
        expect(root.textContent).toContain(
          expected === "B-current" ? "222 total events" : "333 total events",
        );
        expect(root.textContent).not.toContain("111 total events");
      }
      if (kind === "query" || target === "preset") {
        const queryText = [...root.querySelectorAll(".report-pre")]
          .map((node) => node.textContent)
          .join(" ");
        expect(queryText).toContain(expected);
        expect(queryText).not.toContain("old-A");
      }
      if (target === "preset") {
        expect(root.querySelector<HTMLSelectElement>("#capture-preset")?.value).toBe(
          "retry-storms",
        );
      }
    },
  );
});

describe("QA Lab capture destructive actions", () => {
  async function mountCaptureActions() {
    const root = await mountRunner(captureSelection);
    const fallback = httpMock.getJson.getMockImplementation();
    if (!fallback) {
      throw new Error("missing baseline request handler");
    }
    let sessions = ["A", "B"];
    httpMock.getJson.mockImplementation((url: string) => {
      if (url === "/api/capture/sessions") {
        return Promise.resolve({
          sessions: sessions.map((id) => ({
            id,
            startedAt: 1,
            mode: "proxy",
            sourceProcess: "test",
            eventCount: 0,
          })),
        });
      }
      if (url.startsWith("/api/capture/events?")) {
        return Promise.resolve({ events: [] });
      }
      if (url.startsWith("/api/capture/coverage?")) {
        return Promise.resolve({ coverage: null });
      }
      if (url.startsWith("/api/capture/query?")) {
        return Promise.resolve({ rows: [] });
      }
      return fallback(url);
    });
    root.querySelector<HTMLButtonElement>("[data-tab='capture']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='refresh']")?.click();
    await flushCaptureRefresh();
    root.querySelector<HTMLButtonElement>("#capture-controls-toggle")?.click();
    await flushCaptureRefresh();
    expect(
      root.querySelector<HTMLSelectElement>("#capture-session")?.selectedOptions[0]?.value,
    ).toBe("A");
    httpMock.postJson.mockClear();
    return {
      root,
      setSessions: (next: string[]) => {
        sessions = next;
      },
    };
  }

  it.each([
    { id: "D1", action: "delete", outcome: "cancel" },
    { id: "D2", action: "delete", outcome: "success" },
    { id: "D3", action: "delete", outcome: "http" },
    { id: "D4", action: "delete", outcome: "network" },
    { id: "D5", action: "delete", outcome: "timeout" },
    { id: "P1", action: "purge", outcome: "cancel" },
    { id: "P2", action: "purge", outcome: "success" },
    { id: "P3", action: "purge", outcome: "http" },
    { id: "P4", action: "purge", outcome: "malformed" },
    { id: "P5", action: "purge", outcome: "timeout" },
  ] as const)(
    "$id $action $outcome uses the production click handler",
    async ({ action, outcome }) => {
      const { root, setSessions } = await mountCaptureActions();
      const confirm = vi.fn(() => outcome !== "cancel");
      vi.stubGlobal("confirm", confirm);
      const endpoint = action === "delete" ? "/api/capture/delete-sessions" : "/api/capture/purge";
      const body = action === "delete" ? { sessionIds: ["A"] } : {};
      const errors = {
        http: new httpMock.QaLabHttpError("capture rejected", action === "delete" ? 400 : 500, {}),
        network: new Error("capture network unavailable"),
        malformed: new Error("capture malformed JSON response"),
        timeout: new Error("capture request timed out"),
      };
      const expectedError = outcome in errors ? errors[outcome as keyof typeof errors] : null;
      httpMock.postJson.mockImplementation(async (url: string, requestBody: unknown) => {
        expect(url).toBe(endpoint);
        expect(requestBody).toEqual(body);
        if (expectedError) {
          throw expectedError;
        }
        setSessions(action === "delete" ? ["B"] : []);
        return { ok: true };
      });
      const selector =
        action === "delete" ? "#capture-delete-selected-sessions" : "#capture-purge-all";
      const button = root.querySelector<HTMLButtonElement>(selector);
      expect(button?.disabled).toBe(false);
      button?.click();
      await flushCaptureRefresh();
      expect(confirm).toHaveBeenCalledTimes(1);
      if (outcome === "cancel") {
        expect(httpMock.postJson).not.toHaveBeenCalled();
        expect(
          root.querySelector<HTMLSelectElement>("#capture-session")?.selectedOptions[0]?.value,
        ).toBe("A");
        return;
      }
      expect(httpMock.postJson).toHaveBeenCalledTimes(1);
      expect(httpMock.postJson).toHaveBeenCalledWith(endpoint, body);
      if (expectedError) {
        expect(root.querySelector(".badge-fail")?.textContent).toContain(expectedError.message);
        expect(
          root.querySelector<HTMLSelectElement>("#capture-session")?.selectedOptions[0]?.value,
        ).toBe("A");
        return;
      }
      expect(root.querySelector(".badge-fail")?.textContent ?? "").toBe("");
      expect(
        root.querySelector<HTMLSelectElement>("#capture-session option[value='A']"),
      ).toBeNull();
      if (action === "delete") {
        expect(
          root.querySelector<HTMLSelectElement>("#capture-session")?.selectedOptions[0]?.value,
        ).toBe("B");
      } else {
        expect(root.querySelectorAll("#capture-session option")).toHaveLength(0);
      }
    },
  );
});
