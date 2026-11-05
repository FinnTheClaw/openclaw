/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "../lib/config/config-test-harness.ts";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.ts";
import "./settings-save-indicator.ts";

type SettingsSaveIndicatorElement = HTMLElement & {
  props?: SettingsSaveIndicatorProps;
  updateComplete: Promise<boolean>;
};

let indicator: SettingsSaveIndicatorElement;

function props(overrides: Partial<SettingsSaveIndicatorProps> = {}): SettingsSaveIndicatorProps {
  return {
    status: "idle",
    lastError: null,
    needsApply: false,
    applying: false,
    applyDisabled: false,
    onRetry: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  };
}

async function update(next: SettingsSaveIndicatorProps): Promise<void> {
  indicator.props = next;
  await indicator.updateComplete;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...indicator.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  indicator = document.createElement(
    "openclaw-settings-save-indicator",
  ) as SettingsSaveIndicatorElement;
  document.body.append(indicator);
});

afterEach(() => {
  indicator.remove();
  vi.useRealTimers();
});

describe("settings save indicator", () => {
  it("stays empty while idle", async () => {
    await update(props());

    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
  });

  it("renders the shared working claw while saving", async () => {
    await update(props({ status: "saving" }));

    expect(indicator.textContent?.trim()).toBe("Saving…");
    expect(indicator.querySelector(".settings-save-indicator__claw--saving svg")).not.toBeNull();
    expect(
      indicator.querySelector(".settings-save-indicator__claw")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("L02-006-F01 keeps a failed post-save refresh visible and recovers with a read only", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const refreshError = "Configuration refresh unavailable";
    let failReads = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get" && failReads) {
        throw new Error(refreshError);
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    let reloadWork: Promise<void> | undefined;
    const onReload = vi.fn(() => {
      reloadWork = runtimeConfig.refresh();
    });
    const onRetry = vi.fn();
    const raw = '{\n  "count": 2\n}\n';

    try {
      await runtimeConfig.ensureLoaded();
      failReads = true;
      runtimeConfig.setRaw(raw);
      const saved = await runtimeConfig.save();
      await update(
        props({
          status: runtimeConfig.state.configAutoSaveStatus,
          lastError: runtimeConfig.state.lastError,
          needsApply: runtimeConfig.state.configNeedsApply,
          applying: runtimeConfig.state.configApplying,
          onReload,
          onRetry,
        }),
      );
      const failedRefresh = {
        saved,
        hash: runtimeConfig.state.configSnapshot?.hash,
        config: structuredClone(runtimeConfig.state.configSnapshot?.config),
        raw: runtimeConfig.state.configRaw,
        dirty: runtimeConfig.state.configFormDirty,
        needsApply: runtimeConfig.state.configNeedsApply,
        status: runtimeConfig.state.configAutoSaveStatus,
        error: runtimeConfig.state.lastError,
        submissions: server.submissions.map((submission) => ({ ...submission })),
        requestMethods: request.mock.calls.map(([method]) => method),
        warningVisible:
          indicator.querySelector('[role="status"]')?.textContent?.includes(refreshError) ?? false,
        savedVisible: indicator.textContent?.includes("Saved") ?? false,
        falseSaveFailure: indicator.textContent?.includes("Save failed") ?? false,
        reloadAvailable: button("Reload") !== undefined,
        writeRetryAvailable: button("Retry") !== undefined,
      };

      failReads = false;
      button("Reload")?.click();
      await reloadWork;
      await update(
        props({
          status: runtimeConfig.state.configAutoSaveStatus,
          lastError: runtimeConfig.state.lastError,
          needsApply: runtimeConfig.state.configNeedsApply,
          applying: runtimeConfig.state.configApplying,
          onReload,
          onRetry,
        }),
      );
      const recovered = {
        hash: runtimeConfig.state.configSnapshot?.hash,
        config: structuredClone(runtimeConfig.state.configSnapshot?.config),
        raw: runtimeConfig.state.configRaw,
        dirty: runtimeConfig.state.configFormDirty,
        needsApply: runtimeConfig.state.configNeedsApply,
        error: runtimeConfig.state.lastError,
        submissions: server.submissions.map((submission) => ({ ...submission })),
        requestMethods: request.mock.calls.map(([method]) => method),
        reloadCalls: onReload.mock.calls.length,
        retryCalls: onRetry.mock.calls.length,
        warningVisible: indicator.textContent?.includes(refreshError) ?? false,
      };

      expect({ failedRefresh, recovered }).toEqual({
        failedRefresh: {
          saved: true,
          hash: "hash-2",
          config: { count: 2 },
          raw,
          dirty: false,
          needsApply: true,
          status: "saved",
          error: refreshError,
          submissions: [{ method: "config.set", raw, baseHash: "hash-1" }],
          requestMethods: ["config.get", "config.set", "config.get"],
          warningVisible: true,
          savedVisible: true,
          falseSaveFailure: false,
          reloadAvailable: true,
          writeRetryAvailable: false,
        },
        recovered: {
          hash: "hash-2",
          config: { count: 2 },
          raw,
          dirty: false,
          needsApply: true,
          error: null,
          submissions: [{ method: "config.set", raw, baseHash: "hash-1" }],
          requestMethods: ["config.get", "config.set", "config.get", "config.get"],
          reloadCalls: 1,
          retryCalls: 0,
          warningVisible: false,
        },
      });
    } finally {
      await Promise.allSettled(reloadWork ? [reloadWork] : []);
      runtimeConfig.dispose();
    }
  });

  it("shows saved for two seconds after saving, then returns to apply", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    await update(props({ status: "saved", needsApply: true }));

    expect(indicator.textContent).toContain("Saved");
    expect(indicator.querySelector(".settings-save-indicator__claw--saved")).not.toBeNull();
    expect(indicator.querySelector(".settings-save-indicator__check")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(indicator.textContent).toContain("Saved");
    await vi.advanceTimersByTimeAsync(1);
    await indicator.updateComplete;
    expect(indicator.textContent?.trim()).toBe("Apply changes");
  });

  it("surfaces save errors and retries with the original message", async () => {
    const onRetry = vi.fn();
    await update(props({ status: "error", lastError: "permission denied", onRetry }));

    const status = indicator.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Save failed");
    expect(status?.getAttribute("title")).toBe("permission denied");
    expect(status?.getAttribute("aria-label")).toBe("Save failed: permission denied");
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reloads on conflicts instead of offering retry", async () => {
    const onReload = vi.fn();
    await update(props({ status: "conflict", onReload }));

    expect(indicator.textContent).toContain("Settings changed elsewhere");
    expect(button("Retry")).toBeUndefined();
    button("Reload")?.click();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("explains validation rejection locally with a reason and retry action", async () => {
    const onRetry = vi.fn();
    await update(
      props({ status: "rejected", lastError: "logging.level: Invalid option", onRetry }),
    );

    expect(indicator.querySelector('[role="status"]')?.textContent).toContain(
      "Settings not applied",
    );
    expect(indicator.textContent).toContain("Current settings are unchanged.");
    expect(indicator.querySelector("details")?.textContent).toContain(
      "logging.level: Invalid option",
    );
    expect(indicator.querySelector(".settings-save-indicator--danger")).toBeNull();
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("submits the paused draft through Save instead of retrying a failed patch", async () => {
    const onSave = vi.fn();
    const onRetry = vi.fn();
    await update(props({ status: "paused", onSave, onRetry }));

    button("Save")?.click();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("applies pending changes and reports the in-flight state", async () => {
    const onApply = vi.fn();
    await update(props({ needsApply: true, onApply }));

    button("Apply changes")?.click();
    expect(onApply).toHaveBeenCalledOnce();

    await update(props({ needsApply: true, applying: true, onApply }));
    expect(indicator.textContent?.trim()).toBe("Applying…");
    expect(indicator.querySelector(".settings-save-indicator__spinner")).not.toBeNull();
    expect(button("Apply changes")).toBeUndefined();
  });

  it("cleans the saved timer when disconnected", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    expect(vi.getTimerCount()).toBe(0);
    await update(props({ status: "saved" }));
    expect(vi.getTimerCount()).toBe(1);

    indicator.remove();

    expect(vi.getTimerCount()).toBe(0);
  });
});
