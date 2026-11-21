/* @vitest-environment jsdom */
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createBootstrap,
  httpMock,
  mountCapture,
  mountRunner,
  setupAppBrowserTests,
} from "./app.browser.test-support.js";
import { captureEventKey } from "./ui-render-capture-events.js";
import type { EvidenceEnvelope, OutcomesEnvelope, RunnerSelection } from "./ui-types.js";

function createRunnerSelection(): RunnerSelection {
  return {
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
}

function query(root: HTMLElement) {
  return (selector: string) => root.querySelector<HTMLElement>(selector)!;
}

function setValue(root: HTMLElement, selector: string, value: string, event = "change") {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    selector,
  )!;
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

setupAppBrowserTests();

it("keeps capture actions from releasing another pending action's busy state", async () => {
  const root = await mountRunner(createRunnerSelection());
  const $ = query(root);
  const reset = Promise.withResolvers<void>();
  httpMock.postJson.mockImplementationOnce(() => reset.promise);
  const writeText = vi.fn().mockRejectedValue(new Error("Clipboard permission denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  onTestFinished(() => confirm.mockRestore());
  try {
    $('[data-action="reset"]').click();
    $('[data-tab="capture"]').click();
    $("#capture-controls-toggle").click();
    $("[data-copy-text]").click();
    $("#capture-purge-all").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.disabled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(httpMock.postJson).toHaveBeenCalledExactlyOnceWith("/api/reset", {});
    reset.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.disabled).toBe(false);
    $("[data-copy-text]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("pnpm proxy:start --port 7799");
    expect($(".header-status .badge-fail").textContent).toBe("Clipboard permission denied");
    expect(root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.disabled).toBe(false);
  } finally {
    reset.resolve();
  }
});

it.each([
  ["delete-selected-sessions", "delete-sessions", { sessionIds: ["capture-1"] }],
  ["purge-all", "purge", {}],
] as const)("retains capture selection when %s fails", async (action, endpoint, body) => {
  const root = await mountRunner(createRunnerSelection());
  const $ = query(root);
  await mountCapture(root);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  onTestFinished(() => confirm.mockRestore());
  httpMock.postJson.mockRejectedValueOnce(new Error("Capture deletion failed"));
  $(`#capture-${action}`).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(httpMock.postJson).toHaveBeenCalledExactlyOnceWith(`/api/capture/${endpoint}`, body);
  expect($(".header-status .badge-fail").textContent).toBe("Capture deletion failed");
  const selected = root.querySelector<HTMLSelectElement>("#capture-session")!.selectedOptions;
  expect([...selected].map((option) => option.value)).toEqual(["capture-1"]);
});

it.each([
  { shiftKey: false, expectedIds: [1, 2] },
  { shiftKey: true, expectedIds: [1, 2, 3] },
])(
  "keeps the complete sparkline drag window across renders (shift=$shiftKey)",
  async ({ shiftKey, expectedIds }) => {
    const root = await mountRunner(createRunnerSelection());
    await mountCapture(
      root,
      [0, 600, 1200, 1800].map((ts, index) => ({
        id: index + 1,
        ts,
        kind: "request",
        flowId: `flow-${index + 1}`,
        direction: "outbound",
        protocol: "https",
      })),
    );
    setValue(root, "#capture-view-mode", "timeline");
    const bins = () => root.querySelectorAll<HTMLButtonElement>("[data-capture-sparkline-window]");
    bins()[0]!.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    bins()[6]!.dispatchEvent(new MouseEvent("mouseenter"));
    window.dispatchEvent(new MouseEvent("mouseup", { shiftKey }));
    const visibleIds = () =>
      [...root.querySelectorAll<HTMLElement>(".capture-timeline-marker")].map((marker) =>
        Number(marker.dataset.captureEvent!.split(":")[0]),
      );
    expect(visibleIds()).toEqual(expectedIds);
    expect(root.querySelector(".capture-timeline-window-draft")).toBeNull();
    window.dispatchEvent(new MouseEvent("mouseup", { shiftKey: !shiftKey }));
    expect(visibleIds()).toEqual(expectedIds);
  },
);

it.each([
  ["left clipping", 0, 0, -20.5, 29.5],
  ["offset bordered scrollport", 200.25, 2, 500.75, 97.53125],
] as const)(
  "reveals tabs after navigation replacement: %s",
  async (_name, navLeft, clientLeft, tabLeft, expected) => {
    const root = await mountRunner(createRunnerSelection());
    const $ = query(root);
    $('[data-tab="report"]').click();
    const tab = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
    const nav = tab.parentElement!;
    const main = nav.parentElement!;
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(
      new DOMRect(navLeft, 81.5, 320 + 2 * clientLeft, 50.5),
    );
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(new DOMRect(tabLeft, 0, 69.03125));
    Object.defineProperties(nav, {
      clientLeft: { configurable: true, value: clientLeft },
      clientWidth: { configurable: true, value: 320 },
    });
    Object.assign(nav, { scrollLeft: 50, scrollTop: 17 });
    Object.assign(main, { scrollLeft: 11, scrollTop: 23 });
    Object.assign(root, { scrollLeft: 7, scrollTop: 13 });

    tab.focus();
    expect(document.activeElement).toBe(tab);
    expect(nav).toMatchObject({ scrollLeft: expected, scrollTop: 17 });
    expect([main.scrollLeft, main.scrollTop, root.scrollLeft, root.scrollTop]).toEqual([
      11, 23, 7, 13,
    ]);
  },
);

it("refreshes running Control UI links without hiding errors", async () => {
  const bootstrap = createBootstrap(createRunnerSelection());
  const root = await mountRunner(bootstrap.runner.selection);
  const getJson = httpMock.getJson.getMockImplementation()!;
  bootstrap.runner.status = "running";
  const run: NonNullable<OutcomesEnvelope["run"]> = {
    kind: "suite",
    status: "running",
    scenarios: [{ id: "dm-chat-baseline", name: "DM baseline", status: "pending" }],
    counts: { total: 1, pending: 1, running: 0, passed: 0, failed: 0, skipped: 0 },
  };
  httpMock.getJson.mockImplementation(async (url: string) =>
    url === "/api/bootstrap"
      ? structuredClone(bootstrap)
      : url === "/api/outcomes"
        ? { run: structuredClone(run) }
        : getJson(url),
  );
  // The server publishes running/pending before the Gateway link, then waits for transport.
  // Consume that fingerprint first so it cannot hide a later link-only update.
  await vi.advanceTimersByTimeAsync(1_000);
  const readHref = () => root.querySelector(".header-link")?.getAttribute("href") ?? null;
  for (const next of [
    "http://127.0.0.1:43124/control-ui/",
    "http://127.0.0.1:43124/control-ui/?panel=chat",
    null,
  ]) {
    bootstrap.controlUiUrl = next;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readHref()).toBe(next);
    if (next?.endsWith("/control-ui/")) {
      const message = `Request failed: <missing> ${"error-context".repeat(16)}`;
      httpMock.getJson.mockRejectedValueOnce(new Error(message));
      query(root)('[data-action="refresh"]').click();
      await vi.waitFor(() =>
        expect(query(root)(".header-status .badge-fail").textContent).toContain(message),
      );
      expect(readHref()).toBe(next);
    }
  }
});

it("selects duplicate evidence labels independently before and after filtering", async () => {
  const originalUrl = window.location.href;
  onTestFinished(() => window.history.replaceState(null, "", originalUrl));
  window.history.replaceState(null, "", "/evidence?path=fixture/qa-evidence.json");
  const evidence: EvidenceEnvelope["evidence"] = {
    counts: { pass: 1, fail: 0, blocked: 0, skipped: 0 },
    entries: (["fail", "pass"] as const).map((status, index) => ({
      artifacts: [
        {
          exists: true,
          error: null,
          href: `/api/evidence/artifact?entryIndex=${index}&artifactIndex=0`,
          kind: "log",
          mediaKind: "text",
          path: `attempt-${index}.log`,
          preview: `observed attempt ${index}`,
          source: "synthetic-runner",
        },
      ],
      coverage: [],
      failureReason: null,
      key: String(index),
      effective: index === 1,
      id: "same-label",
      kind: "script-test",
      sourcePath: null,
      status,
      title: `Attempt ${index}`,
    })),
    evidenceMode: "full",
    evidencePath: "fixture/qa-evidence.json",
    generatedAt: "2026-06-17T12:00:00.000Z",
    producerContext: null,
    profile: null,
    schemaVersion: 3,
  };
  const root = await mountRunner(createRunnerSelection(), undefined, evidence);
  const $ = query(root);
  expect($(".evidence-inspector").textContent).toContain("observed attempt 0");
  $('[data-evidence-entry-key="1"]').click();
  expect($(".evidence-inspector").textContent).toContain("observed attempt 1");
  expect($(".evidence-inspector").textContent).not.toContain("observed attempt 0");
  expect(root.querySelectorAll(".evidence-entry-card.selected")).toHaveLength(1);
  setValue(root, "#evidence-status-filter", "fail");
  expect($(".evidence-inspector").textContent).toContain("observed attempt 0");
  expect($(".evidence-inspector").textContent).toContain("not counted");
  setValue(root, "#evidence-status-filter", "all");
  $('[data-evidence-entry-key="1"]').click();
  expect($(".evidence-inspector").textContent).toContain("observed attempt 1");
});

it("sends group conversation messages from the interactive chat composer", async () => {
  const root = await mountRunner(createRunnerSelection(), {
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
  });
  const $ = query(root);
  httpMock.postJson.mockResolvedValue({ message: { id: "group-message" } });

  $("[data-thread-select='owned-thread']").click();
  setValue(root, "#conversation-kind", "group");
  setValue(root, "#conversation-id", "qa-group", "input");
  setValue(root, "#composer-text", "hello group", "input");
  $("[data-action='send']").click();
  await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
  expect(httpMock.postJson).toHaveBeenCalledWith(
    "/api/inbound/message",
    expect.objectContaining({
      accountId: "default",
      conversation: { id: "qa-group", kind: "group", title: "qa-group" },
      text: "hello group",
    }),
  );
  expect(httpMock.postJson.mock.calls[0]?.[1]).not.toHaveProperty("threadId");
});

it("submits channel, profile, explicit-scenario and live-provider configuration changes", async () => {
  const root = await mountRunner(createRunnerSelection());
  const $ = query(root);
  const configure = (changes: Record<string, string>) => {
    $("[data-sidebar-panel='config']").click();
    for (const [id, value] of Object.entries(changes)) {
      setValue(root, `#${id}`, value);
    }
  };
  const launch = async (expected: Partial<RunnerSelection>) => {
    httpMock.postJson.mockClear();
    $("[data-action='run-suite']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(httpMock.postJson).toHaveBeenCalledExactlyOnceWith(
      "/api/scenario/suite",
      expect.objectContaining(expected),
    );
  };
  configure({ "channel-driver": "live", "execution-channel": "telegram" });
  await launch({ channelDriver: "live", channel: "telegram", providerMode: "mock-openai" });
  configure({
    "run-profile": "smoke-ci",
    "evidence-mode": "slim",
    "runtime-pair": "openclaw,codex",
    "runtime-pair-lane": "core",
  });
  await launch({
    profile: "smoke-ci",
    channelDriver: "crabline",
    evidenceMode: "slim",
    runtimePair: ["openclaw", "codex"],
    runtimePairLane: "core",
    scenarioIds: null,
  });
  configure({ "run-profile": "smoke-ci" });
  $("[data-sidebar-panel='scenarios']").click();
  $("[data-scenario-toggle-id='browser-talk-start-stop']").click();
  await launch({ scenarioIds: ["browser-talk-start-stop"] });
  configure({ "provider-mode": "live-frontier" });
  $("[data-sidebar-panel='scenarios']").click();
  $("[data-action='select-all-scenarios']").click();
  await launch({
    providerMode: "live-frontier",
    scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
  });
  $("[data-sidebar-panel='scenarios']").click();
  $("[data-scenario-toggle-id='dm-chat-baseline']").click();
  $("[data-scenario-toggle-id='browser-talk-start-stop']").click();
  httpMock.postJson.mockClear();
  const runButton = root.querySelector<HTMLButtonElement>("[data-action='run-suite']")!;
  expect(runButton.disabled).toBe(true);
  expect(runButton.textContent).toContain("Run 0 scenarios");
  runButton.click();
  expect(httpMock.postJson).not.toHaveBeenCalled();
});

it("renders server-resolved exclusions and errors from a rejected launch", async () => {
  const root = await mountRunner(createRunnerSelection());
  const $ = query(root);
  const plan = createBootstrap(createRunnerSelection()).runner.plan!;
  plan.errors = ["Explicit QA scenario selection is not runnable."];
  plan.exclusions = [
    {
      executionKind: "flow",
      reasons: ["channel=telegram"],
      scenarioId: "dm-chat-baseline",
    },
  ];
  Object.assign(plan, { executionKinds: [], selectedScenarios: [], status: "invalid" });
  httpMock.postJson.mockRejectedValueOnce(
    new httpMock.QaLabHttpError("selection rejected", { plan }),
  );

  $("[data-action='run-suite']").click();
  await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
  expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
  expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

  $("[data-sidebar-panel='config']").click();
  setValue(root, "#evidence-mode", "slim");
  $("[data-sidebar-panel='run']").click();
  expect(root.textContent).not.toContain("Explicit QA scenario selection is not runnable");
  expect(root.textContent).not.toContain("Resolved plan:");
});

async function mountNavigation() {
  const snapshot: QaBusStateSnapshot = {
    conversations: [{ accountId: "default", id: "alice", kind: "direct" }],
    cursor: 0,
    events: [],
    messages: [],
    threads: [],
  };
  const root = await mountRunner(createRunnerSelection(), snapshot);
  return { root, snapshot, $: query(root) };
}

async function pollWithMessage(snapshot: QaBusStateSnapshot) {
  const message: QaBusStateSnapshot["messages"][number] = {
    accountId: "default",
    conversation: { id: "alice", kind: "direct" },
    direction: "inbound",
    id: `message-${snapshot.messages.length + 1}`,
    reactions: [],
    senderId: "alice",
    text: "new polling message",
    timestamp: 1,
  };
  snapshot.messages.push(message);
  snapshot.events.push({
    accountId: message.accountId,
    cursor: ++snapshot.cursor,
    kind: "inbound-message",
    message,
  });
  await vi.advanceTimersByTimeAsync(1_000);
}

function mockTabGeometry(root: HTMLElement) {
  const offsets = new WeakMap<Element, number>();
  const width = (nav: Element) =>
    nav.closest(".app-shell--evidence-focus, .app-shell--sidebar-collapsed") ? 800 : 440;
  // jsdom has no layout. Model the shell width and native clamping while the
  // actual app binding and revealTab own every focus-driven scroll adjustment.
  const properties = ["clientWidth", "scrollLeft", "getBoundingClientRect"];
  const original = Object.fromEntries(
    properties.map(
      (key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)!] as const,
    ),
  );
  Object.defineProperties(Element.prototype, {
    clientWidth: {
      configurable: true,
      get(this: Element) {
        return root.contains(this) && this.matches("nav.tab-bar") ? width(this) : 0;
      },
    },
    scrollLeft: {
      configurable: true,
      get(this: Element) {
        return offsets.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        offsets.set(this, Math.max(0, Math.min(value, 600 - width(this))));
      },
    },
    getBoundingClientRect: {
      configurable: true,
      value(this: Element) {
        if (root.contains(this) && this.matches("nav.tab-bar")) {
          return new DOMRect(0, 0, width(this), 40);
        }
        const nav = this.parentElement;
        return root.contains(this) &&
          nav?.matches("nav.tab-bar") &&
          this.matches("button[data-tab]")
          ? new DOMRect([...nav.children].indexOf(this) * 100 - nav.scrollLeft, 0, 100, 40)
          : new DOMRect();
      },
    },
  });
  onTestFinished(() => {
    Object.defineProperties(Element.prototype, original);
  });
}

it.each([false, true])(
  "retains tab visibility and sidebar preference across width changes (collapsed=%s)",
  async (collapsed) => {
    localStorage.setItem("qa-lab-sidebar-collapsed", collapsed ? "1" : "0");
    const { root, $ } = await mountNavigation();
    const tab = (id: string) => $(`[data-tab="${id}"]`);
    mockTabGeometry(root);
    expect(getComputedStyle($(".scenario-scroll")).overflowY).toBe("auto");
    expect(getComputedStyle($(".scenario-item")).flexShrink).toBe("0");
    tab("capture").focus();
    tab("evidence").focus();
    tab("evidence").click();
    const evidence = tab("evidence");
    expect(document.activeElement).toBe(evidence);
    expect(evidence.parentElement).toMatchObject({ clientWidth: 800, scrollLeft: 0 });
    expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "1" : "0");
    tab("capture").focus();
    expect(tab("capture").parentElement).toMatchObject({ clientWidth: 800, scrollLeft: 0 });
    tab("capture").click();
    const next = tab("capture");
    const nav = next.parentElement!;
    expect(document.activeElement).toBe(next);
    expect(nav).toMatchObject({
      clientWidth: collapsed ? 800 : 440,
      scrollLeft: collapsed ? 0 : 160,
    });
    expect(next.getBoundingClientRect().right).toBeLessThanOrEqual(nav.clientWidth);
    $('[data-action="toggle-sidebar"]').click();
    expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "0" : "1");
    tab("evidence").click();
    tab("chat").click();
    expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(!collapsed);
  },
);

it("retains the active Events tab through a changed poll", async () => {
  const { snapshot, $ } = await mountNavigation();
  $('[data-tab="events"]').click();
  await pollWithMessage(snapshot);
  expect($(".events-scroll").textContent).toContain("new polling message");
  expect($("[data-tab='events']").classList.contains("active")).toBe(true);
});

it.each(["tab", "outside", "input", "composer", "select"] as const)(
  "preserves %s focus, draft and navigation scroll across polling",
  async (kind) => {
    const { root, snapshot, $ } = await mountNavigation();
    const isTab = kind === "tab";
    const isDraft = kind === "input" || kind === "composer";
    const external = kind === "outside";
    mockTabGeometry(root);
    const selector = isTab
      ? '[data-tab="capture"]'
      : kind === "composer"
        ? "#composer-text"
        : isDraft
          ? "#conversation-id"
          : "#conversation-kind";
    if (kind === "outside") {
      $('[data-tab="report"]').focus();
      const outside = document.createElement("nav");
      outside.innerHTML = '<button data-tab="report" id="composer-text">Outside</button>';
      outside.className = "tab-bar";
      document.body.append(outside);
      outside.querySelector("button")!.focus();
    } else {
      if (isDraft) {
        setValue(root, selector, "unfinished draft", "input");
      }
      $(selector).focus();
    }
    const focused = document.activeElement;
    const nav = $("nav.tab-bar");
    nav.scrollLeft = 137.25;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(document.activeElement).toBe(focused);
    expect(nav.scrollLeft).toBe(137.25);

    await pollWithMessage(snapshot);
    if (kind === "select") {
      expect($("nav.tab-bar")).toBe(nav);
      expect(document.activeElement).toBe(focused);
      expect($("#chat-messages").textContent).not.toContain("new polling message");
      $(selector).blur();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const nextNav = $("nav.tab-bar");
    expect(nextNav.scrollLeft).toBe(137.25);
    expect(document.activeElement).toBe(
      external ? focused : kind === "select" ? document.body : $(selector),
    );
    expect($("#chat-messages").textContent).toContain("new polling message");
    if (isDraft) {
      expect(root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!.value).toBe(
        "unfinished draft",
      );
    }
    if (isTab) {
      $('[data-tab="events"]').click();
      expect($(".events-scroll").textContent).toContain("new polling message");
    }
  },
);

it.each([
  { name: "capture-detail-view", parentView: "overview", value: "flow" },
  { name: "capture-flow-layout", parentView: "flow", value: "nav-first" },
  { name: "capture-payload-layout", parentView: "payload", value: "raw" },
  { name: "capture-payload-extent", parentView: "payload", value: "full" },
  { name: "capture-payload-event-sort", parentView: "payload", value: "name" },
])(
  "retains capture radio focus after option changes ($name)",
  async ({ name, parentView, value }) => {
    const root = await mountRunner(createRunnerSelection());
    const getJson = httpMock.getJson.getMockImplementation()!;
    httpMock.getJson.mockImplementation(async (url: string) => {
      if (url === "/api/capture/sessions") {
        return {
          sessions: [{ id: "capture-focus", startedAt: 0, mode: "proxy", eventCount: 2 }],
        };
      }
      if (url.startsWith("/api/capture/events?")) {
        return {
          events: ["request", "response"].map((kind, index) => ({
            id: index + 1,
            ts: index * 600,
            kind,
            flowId: "SYNTHETIC_FOCUS_FLOW",
            direction: index === 0 ? "outbound" : "inbound",
            protocol: "https",
            host: "example.test",
            path: "/synthetic-focus",
            method: "GET",
            contentType: "text/event-stream",
            [parentView === "payload" ? "dataText" : "payloadPreview"]:
              'event: synthetic\ndata: {"value":"FAKE_FOCUS_PAYLOAD"}\n\n',
          })),
        };
      }
      if (url.startsWith("/api/capture/coverage?")) return { coverage: null };
      return getJson(url);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!.click();
    const parent = root.querySelector<HTMLInputElement>(
      `input[name="capture-detail-view"][value="${parentView}"]`,
    );
    expect(parent).not.toBeNull();
    parent!.checked = true;
    parent!.dispatchEvent(new Event("change", { bubbles: true }));
    const selector = `input[name="${name}"][value="${value}"]`;
    const target = root.querySelector<HTMLInputElement>(selector);
    expect(target).not.toBeNull();
    target!.focus();
    const prerequisites = {
      enabled: !target!.disabled,
      checked: target!.checked,
      focused: document.activeElement === target,
      inRoot: root.contains(target),
    };
    // These are component setup prerequisites, not assertions about browser arrow-key handling.
    expect(prerequisites).toEqual({ enabled: true, checked: false, focused: true, inRoot: true });
    target!.checked = true;
    target!.dispatchEvent(new Event("change", { bubbles: true }));
    const replacement = root.querySelector<HTMLInputElement>(selector);
    const facts = {
      oldConnected: target!.isConnected,
      replaced: replacement != null && replacement !== target,
      name: replacement?.name,
      value: replacement?.value,
      checked: replacement?.checked,
      checkedCount: root.querySelectorAll(`input[name="${name}"]:checked`).length,
      focusedReplacement: replacement != null && document.activeElement === replacement,
    };
    expect.soft(facts).toEqual({
      oldConnected: false,
      replaced: true,
      name,
      value,
      checked: true,
      checkedCount: 1,
      focusedReplacement: true,
    });
  },
);

it.each([
  { name: "previous kind-filter target", navigation: "previous", exclusion: "kind", target: 0 },
  { name: "next kind-filter target", navigation: "next", exclusion: "kind", target: 2 },
  { name: "paired timeline-window target", navigation: "pair", exclusion: "window", target: 2 },
  { name: "already-visible next target", navigation: "next", exclusion: "none", target: 2 },
] as const)(
  "selects capture flow targets outside the current view ($name)",
  async ({ navigation, exclusion, target }) => {
    const events = [
      { id: 1, ts: 0, kind: "ws-open", path: "/synthetic-previous" },
      { id: 2, ts: 600, kind: "request", path: "/synthetic-selected" },
      { id: 3, ts: 1200, kind: "response", path: "/synthetic-next" },
      { id: 4, ts: 1800, kind: "request", path: "/synthetic-other" },
    ].map((event) => ({
      ...event,
      flowId: event.id === 4 ? "other-flow" : "navigation-flow",
      host: "example.test",
      method: "GET",
      direction: "outbound",
      protocol: "https",
    }));
    const root = await mountRunner(createRunnerSelection());
    const getJson = httpMock.getJson.getMockImplementation()!;
    httpMock.getJson.mockImplementation(async (url: string) => {
      if (url === "/api/capture/sessions") {
        return {
          sessions: [{ id: "capture-navigation", startedAt: 0, mode: "proxy", eventCount: 4 }],
        };
      }
      if (url.startsWith("/api/capture/events?")) return { events };
      if (url.startsWith("/api/capture/coverage?")) return { coverage: null };
      return getJson(url);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!.click();
    root.querySelector<HTMLButtonElement>("#capture-controls-toggle")!.click();
    if (exclusion === "kind") {
      setValue(root, "#capture-kind-filter", "request");
    }
    if (exclusion === "window") {
      setValue(root, "#capture-view-mode", "timeline");
      const bins = root.querySelectorAll<HTMLButtonElement>("[data-capture-sparkline-window]");
      expect(bins.length).toBeGreaterThan(10);
      bins[6]!.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      bins[10]!.dispatchEvent(new MouseEvent("mouseenter"));
      window.dispatchEvent(new MouseEvent("mouseup"));
    } else {
      root
        .querySelector<HTMLButtonElement>(
          `.capture-event-card[data-capture-event="${captureEventKey(events[1]!)}"]`,
        )!
        .click();
    }
    const flow = root.querySelector<HTMLInputElement>(
      'input[name="capture-detail-view"][value="flow"]',
    );
    expect(flow).not.toBeNull();
    flow!.checked = true;
    flow!.dispatchEvent(new Event("change", { bubbles: true }));
    const expectedTarget = events[target]!;
    const targetKey = captureEventKey(expectedTarget);
    const targetButton = root.querySelector<HTMLButtonElement>(
      `${navigation === "pair" ? ".capture-pair-card" : ".capture-nav-button"}[data-capture-event="${targetKey}"]`,
    );
    const visibleSelector =
      exclusion === "window" ? ".capture-timeline-marker" : ".capture-event-card";
    const expectedVisibleKeys = (
      exclusion === "kind"
        ? [events[1]!, events[3]!]
        : exclusion === "window"
          ? [events[1]!]
          : events
    )
      .map(captureEventKey)
      .toReversed();
    const prerequisites = {
      selectedKind: root.querySelector(".capture-detail-meta .capture-chip")?.textContent,
      flowPosition: root
        .querySelector(".capture-nav-row")
        ?.closest(".capture-detail-section")
        ?.querySelector(".capture-detail-mini-meta .capture-chip")?.textContent,
      targetKey: targetButton?.dataset.captureEvent,
      enabled: targetButton != null && !targetButton.disabled,
      advertisesExclusion:
        targetButton
          ?.closest(".capture-detail-section")
          ?.textContent?.includes(
            exclusion === "window" ? "outside current window/filter" : "outside current view",
          ) ?? false,
      visibleKeys: [...root.querySelectorAll<HTMLElement>(visibleSelector)].map(
        (node) => node.dataset.captureEvent,
      ),
      kindFilter: [
        ...root.querySelector<HTMLSelectElement>("#capture-kind-filter")!.selectedOptions,
      ].map((option) => option.value),
    };
    // A missing button, wrong selection or window is setup failure, not product navigation evidence.
    expect(prerequisites).toEqual({
      selectedKind: "request",
      flowPosition: "2 / 3",
      targetKey,
      enabled: true,
      advertisesExclusion: exclusion !== "none",
      visibleKeys: expectedVisibleKeys,
      kindFilter: exclusion === "kind" ? ["request"] : [],
    });
    targetButton!.click();
    const selectedKind = root.querySelector(".capture-detail-meta .capture-chip")?.textContent;
    const flowPosition = root
      .querySelector(".capture-nav-row")
      ?.closest(".capture-detail-section")
      ?.querySelector(".capture-detail-mini-meta .capture-chip")?.textContent;
    const visibleKeys = [...root.querySelectorAll<HTMLElement>(visibleSelector)].map(
      (node) => node.dataset.captureEvent,
    );
    const kindFilter = [
      ...root.querySelector<HTMLSelectElement>("#capture-kind-filter")!.selectedOptions,
    ].map((option) => option.value);
    const overview = root.querySelector<HTMLInputElement>(
      'input[name="capture-detail-view"][value="overview"]',
    );
    expect(overview).not.toBeNull();
    overview!.checked = true;
    overview!.dispatchEvent(new Event("change", { bubbles: true }));
    const detailText = root.querySelector(".capture-detail-view-body")?.textContent ?? "";
    expect.soft(selectedKind).toBe(expectedTarget.kind);
    expect.soft(flowPosition).toBe(`${target + 1} / 3`);
    expect.soft(detailText).toContain(expectedTarget.path);
    expect.soft(visibleKeys).toEqual(expectedVisibleKeys);
    expect.soft(kindFilter).toEqual(prerequisites.kindFilter);
  },
);

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
      setValue(root, "#capture-preset", "double-sends");
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
        setValue(root, "#capture-session", "B");
      } else if (target === "preset") {
        setValue(root, "#capture-preset", "retry-storms");
      } else {
        root.querySelector<HTMLButtonElement>("[data-action='refresh']")?.click();
      }
      await flushCaptureRefresh();
      if (target === "A-B-A") {
        requestNumber = 3;
        setValue(root, "#capture-session", "A");
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
