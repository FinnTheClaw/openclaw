/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderProviderProfiles, type ProviderProfilesViewProps } from "./profiles-view.ts";

function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    profileOrders: {},
    profileOrderStoredProviders: [],
    profileOrderExplicitProviders: [],
    profileOrderLocks: {},
    credentialProviderIds: ["openai"],
    logoutTargets: [],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    ...overrides,
  };
}

function props(overrides: Partial<ProviderProfilesViewProps> = {}): ProviderProfilesViewProps {
  return {
    busy: {},
    canMutate: true,
    mutationBlockedReason: null,
    profileOrders: {},
    onAddAccount: () => undefined,
    addAccountDisabled: false,
    onProfileOrderChange: () => undefined,
    onRequestLogout: () => undefined,
    ...overrides,
  };
}

function mount(template: unknown): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(template, container);
  return container;
}

function reorderCard(): ModelProviderCard {
  return card({
    id: "route-one",
    profiles: ["one", "two", "three", "other"].map((name) => ({
      profileId: `account:${name}`,
      email: `${name}@example.com`,
      type: "oauth",
      status: "ok",
    })),
    profileProviderIds: {
      "account:one": "credential-owner",
      "account:two": "credential-owner",
      "account:three": "credential-owner",
      "account:other": "other-owner",
    },
    profileOrders: {
      "credential-owner": ["account:one", "account:two", "account:three"],
      "other-owner": ["account:other"],
    },
  });
}

function pointer(target: Element, type: string, coordinates = { x: 20, y: 75 }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: coordinates.x,
    clientY: coordinates.y,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  target.dispatchEvent(event);
}

function pointerFixture(viewProps: ProviderProfilesViewProps) {
  const container = mount(renderProviderProfiles(reorderCard(), viewProps));
  const grip = container.querySelector<HTMLButtonElement>(".model-providers__profile-grip")!;
  const target = container.querySelector<HTMLElement>('[data-profile-id="account:three"]')!;
  // Different row heights occur when account metadata wraps on narrow screens.
  let top = 0;
  const rows = [...container.querySelectorAll<HTMLElement>(".model-providers__profile")];
  for (const [index, row] of rows.entries()) {
    const height = [80, 120, 100, 100][index]!;
    const bounds = new DOMRect(0, top, 100, height);
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const offset = Number.parseFloat(row.style.translate.split(" ")[1] ?? "0");
      return new DOMRect(0, bounds.top + offset, 100, height);
    });
    top += height;
  }
  const hitTest = vi.fn((): Element | null => target);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  const row = grip.closest<HTMLElement>(".model-providers__profile")!;
  return { container, grip, row, rows, target, hitTest };
}

describe("renderProviderProfiles", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("shows account provenance and removes drag handles for config-locked priority", () => {
    const onProfileOrderChange = vi.fn();
    const providerCard = card({
      profiles: [
        {
          profileId: "openai:configured",
          type: "oauth",
          status: "ok",
          source: "config",
          email: "configured@example.com",
        },
        {
          profileId: "openai:codex",
          type: "oauth",
          status: "ok",
          source: "external",
          displayName: "Codex import",
          email: "codex@example.com",
        },
        {
          profileId: "openai:saved",
          type: "oauth",
          status: "ok",
          source: "saved",
          email: "saved@example.com",
        },
        {
          profileId: "openai:inherited",
          type: "oauth",
          status: "ok",
          source: "inherited",
          email: "inherited@example.com",
        },
      ],
      profileProviderIds: {
        "openai:configured": "openai-config",
        "openai:codex": "openai-config",
        "openai:saved": "openai",
        "openai:inherited": "openai",
      },
      profileOrders: {
        "openai-config": ["openai:configured"],
        openai: ["openai:saved", "openai:inherited"],
      },
      profileOrderLocks: { "openai-config": "provider-config" },
    });

    mount(renderProviderProfiles(providerCard, props({ onProfileOrderChange })));

    expect(document.querySelectorAll(".model-providers__profile-grip")).toHaveLength(2);
    expect(
      document.querySelector(
        '[data-profile-id="openai:configured"] .model-providers__profile-grip',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-profile-id="openai:codex"] .model-providers__profile-grip'),
    ).toBeNull();
    expect(document.querySelector(".model-providers__profile-logout")).toBeNull();
    expect(document.body.textContent).toContain("Provider config");
    expect(document.body.textContent).toContain("Codex import");
    expect(document.body.textContent).not.toContain("Saved in OpenClaw");
    expect(document.body.textContent).toContain("Shared credential");
    expect(document.body.textContent).toContain("Priority is managed by provider configuration");
    expect(
      [...document.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain("Clear custom order");
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("points auth-config priority locks to auth.order", () => {
    const container = mount(
      renderProviderProfiles(
        card({
          profiles: [
            { profileId: "openai:one", type: "oauth", status: "ok" },
            { profileId: "openai:two", type: "oauth", status: "ok" },
          ],
          profileProviderIds: {
            "openai:one": "openai",
            "openai:two": "openai",
          },
          profileOrders: { openai: ["openai:one", "openai:two"] },
          profileOrderLocks: { openai: "auth-config" },
        }),
        props(),
      ),
    );

    expect(container.textContent).toContain("Priority is managed by auth.order");
    expect(container.textContent).not.toContain("provider configuration");
    expect(container.querySelectorAll(".model-providers__profile-grip")).toHaveLength(0);
  });

  it("keeps an environment API-key source visible beside account profiles", () => {
    const result = mount(
      renderProviderProfiles(
        card({
          apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
          profiles: [
            {
              profileId: "openai:oauth",
              type: "oauth",
              status: "ok",
              source: "saved",
            },
          ],
          profileOrders: { openai: ["openai:oauth"] },
        }),
        props(),
      ),
    );

    expect(result.textContent).toContain("API key from environment (OPENAI_API_KEY)");
  });

  it("disables reordering when a same-length stored order contains a stale profile", () => {
    const onProfileOrderChange = vi.fn();
    const providerCard = card({
      profiles: [
        { profileId: "openai:one", type: "oauth", status: "ok" },
        { profileId: "openai:two", type: "oauth", status: "ok" },
      ],
      profileProviderIds: {
        "openai:one": "openai",
        "openai:two": "openai",
      },
      profileOrders: { openai: ["openai:removed", "openai:one"] },
      profileOrderStoredProviders: ["openai"],
    });

    const container = mount(renderProviderProfiles(providerCard, props({ onProfileOrderChange })));
    const grips = container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip");
    expect(grips).toHaveLength(2);
    expect([...grips].every((grip) => grip.disabled)).toBe(true);
    expect(container.textContent).toContain("Clear custom order");
    pointer(grips[0]!, "pointerdown");
    grips[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("identifies managed priority when a shared order spans provider routes", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      renderProviderProfiles(
        card({
          id: "route-one",
          profiles: [
            { profileId: "shared:one", type: "oauth", status: "ok" },
            { profileId: "shared:two", type: "oauth", status: "ok" },
          ],
          profileProviderIds: {
            "shared:one": "shared-owner",
            "shared:two": "shared-owner",
          },
          profileOrders: {
            "shared-owner": ["shared:one", "shared:two", "shared:three"],
          },
        }),
        props({ onProfileOrderChange }),
      ),
    );

    expect(container.querySelectorAll(".model-providers__profile-grip")).toHaveLength(0);
    expect(container.textContent).toContain(
      "Priority is inherited or managed across provider routes",
    );
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("L02-140-F01 changes account priority using clicks without dragging or arrow keys", async () => {
    const providerCard = reorderCard();
    const onAddAccount = vi.fn();
    const onRequestLogout = vi.fn();
    const onProfileOrderChange = vi.fn(
      (_cardId: string, provider: string, order: string[] | null) => {
        if (!order) {
          throw new Error("Expected an account order");
        }
        viewProps = {
          ...viewProps,
          profileOrders: { ...viewProps.profileOrders, [provider]: order },
        };
        queueMicrotask(() => render(renderProviderProfiles(providerCard, viewProps), container));
      },
    );
    let viewProps = props({ onProfileOrderChange, onAddAccount, onRequestLogout });
    const container = mount(renderProviderProfiles(providerCard, viewProps));
    const initialMoves = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) =>
        button.textContent?.trim() === "Move up" || button.textContent?.trim() === "Move down",
    );
    const initial = {
      moveCount: initialMoves.length,
      namesIncludeActionAndAccount: initialMoves.every((button) => {
        const row = button.closest<HTMLElement>(".model-providers__profile");
        const account = providerCard.profiles.find(
          (profile) => profile.profileId === row?.dataset.profileId,
        );
        const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
        return (
          name.includes(button.textContent?.trim() ?? "") && name.includes(account?.email ?? "")
        );
      }),
    };
    const journey = [];
    for (const [index, direction] of ["Move up", "Move down", "Move down"].entries()) {
      const row = container.querySelector<HTMLElement>('[data-profile-id="account:two"]')!;
      const control = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === direction,
      );
      const available = Boolean(control && !control.disabled);
      control?.click();
      await Promise.resolve();
      const movedRow = container.querySelector<HTMLElement>('[data-profile-id="account:two"]')!;
      const up = [...movedRow.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Move up",
      );
      const down = [...movedRow.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Move down",
      );
      if (index === 0) {
        up?.click();
      } else if (index === 2) {
        down?.click();
      }
      await Promise.resolve();
      journey.push({
        direction,
        available,
        order: [...container.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
          (entry) => entry.dataset.profileId,
        ),
        calls: onProfileOrderChange.mock.calls.length,
        upDisabled: up?.disabled,
        downDisabled: down?.disabled,
      });
    }
    const calls = onProfileOrderChange.mock.calls.map(([cardId, provider, order]) => ({
      cardId,
      provider,
      order: order?.slice(),
    }));
    const otherMoves = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-profile-id="account:other"] button'),
    ].filter(
      (button) =>
        button.textContent?.trim() === "Move up" || button.textContent?.trim() === "Move down",
    ).length;

    expect({
      initial,
      journey,
      calls,
      otherMoves,
      addCalls: onAddAccount.mock.calls.length,
      logoutCalls: onRequestLogout.mock.calls.length,
    }).toEqual({
      initial: { moveCount: 6, namesIncludeActionAndAccount: true },
      journey: [
        {
          direction: "Move up",
          available: true,
          order: ["account:two", "account:one", "account:three", "account:other"],
          calls: 1,
          upDisabled: true,
          downDisabled: false,
        },
        {
          direction: "Move down",
          available: true,
          order: ["account:one", "account:two", "account:three", "account:other"],
          calls: 2,
          upDisabled: false,
          downDisabled: false,
        },
        {
          direction: "Move down",
          available: true,
          order: ["account:one", "account:three", "account:two", "account:other"],
          calls: 3,
          upDisabled: false,
          downDisabled: true,
        },
      ],
      calls: [
        {
          cardId: "route-one",
          provider: "credential-owner",
          order: ["account:two", "account:one", "account:three"],
        },
        {
          cardId: "route-one",
          provider: "credential-owner",
          order: ["account:one", "account:two", "account:three"],
        },
        {
          cardId: "route-one",
          provider: "credential-owner",
          order: ["account:one", "account:three", "account:two"],
        },
      ],
      otherMoves: 0,
      addCalls: 0,
      logoutCalls: 0,
    });
  });

  it.each(["read-only", "auth-config lock", "stale incomplete"] as const)(
    "L02-140-F01 prevents click priority changes for %s",
    (eligibility) => {
      const providerCard = reorderCard();
      if (eligibility === "auth-config lock") {
        providerCard.profileOrderLocks = { "credential-owner": "auth-config" };
      } else if (eligibility === "stale incomplete") {
        providerCard.profileOrders = {
          ...providerCard.profileOrders,
          "credential-owner": ["account:missing", "account:one", "account:two"],
        };
        providerCard.profileOrderStoredProviders = ["credential-owner"];
      }
      const onProfileOrderChange = vi.fn();
      const container = mount(
        renderProviderProfiles(
          providerCard,
          props({ canMutate: eligibility !== "read-only", onProfileOrderChange }),
        ),
      );
      const before = [...container.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      );
      const controls = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) =>
          button.textContent?.trim() === "Move up" || button.textContent?.trim() === "Move down",
      );
      const enabled = controls.filter((button) => !button.disabled).length;
      for (const control of controls) {
        control.click();
      }
      const after = [...container.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      );

      expect({ enabled, after, calls: onProfileOrderChange.mock.calls }).toEqual({
        enabled: 0,
        after: before,
        calls: [],
      });
    },
  );

  it("previews the reordered gap, reverses it, then saves using the credential owner", () => {
    const onProfileOrderChange = vi.fn();
    const { grip, row, rows, hitTest, container } = pointerFixture(props({ onProfileOrderChange }));

    pointer(grip, "pointerdown");
    pointer(grip, "pointermove", { x: 20, y: 140 });
    expect(rows[1]!.style.translate).toBe("0px -80px");
    expect(rows[2]!.style.translate).toBe("0px 0px");
    pointer(grip, "pointermove", { x: 40, y: 285 });
    expect(row.style.translate).toBe("20px 210px");
    expect(rows[1]!.style.translate).toBe("0px -80px");
    expect(rows[2]!.style.translate).toBe("0px -80px");
    expect(rows[3]!.style.translate).toBe("");
    // The pointer can be over the new gap, not a row. Repeating it must not
    // change the preview after the neighbors have animated into their slots.
    hitTest.mockReturnValue(container.querySelector(".model-providers__profile-list"));
    pointer(grip, "pointermove", { x: 40, y: 285 });
    expect(rows[2]!.style.translate).toBe("0px -80px");
    pointer(grip, "pointermove");
    expect(rows[1]!.style.translate).toBe("0px 0px");
    expect(rows[2]!.style.translate).toBe("0px 0px");
    expect(onProfileOrderChange).not.toHaveBeenCalled();
    pointer(grip, "pointermove", { x: 40, y: 285 });
    pointer(grip, "pointerup", { x: 40, y: 285 });
    expect(rows.every((candidate) => candidate.style.translate === "")).toBe(true);

    expect(onProfileOrderChange).toHaveBeenCalledExactlyOnceWith("route-one", "credential-owner", [
      "account:two",
      "account:three",
      "account:one",
    ]);

    const lastGrip = rows[2]!.querySelector<HTMLButtonElement>(".model-providers__profile-grip")!;
    pointer(lastGrip, "pointerdown", { x: 20, y: 250 });
    pointer(lastGrip, "pointermove", { x: 20, y: 185 });
    expect(rows[0]!.style.translate).toBe("0px 0px");
    expect(rows[1]!.style.translate).toBe("0px 100px");
    pointer(lastGrip, "pointermove", { x: 20, y: 20 });
    expect(rows[0]!.style.translate).toBe("0px 100px");
    expect(rows[1]!.style.translate).toBe("0px 100px");
    pointer(lastGrip, "pointerup", { x: 20, y: 20 });
    expect(onProfileOrderChange).toHaveBeenNthCalledWith(2, "route-one", "credential-owner", [
      "account:three",
      "account:one",
      "account:two",
    ]);
    expect(rows.every((candidate) => candidate.style.translate === "")).toBe(true);
  });

  it.each(["Escape", "pointercancel", "lostpointercapture", "outside-section", "other-owner"])(
    "does not save a %s drag and allows the next drag",
    (ending) => {
      const onProfileOrderChange = vi.fn();
      const { container, grip, row, rows, target, hitTest } = pointerFixture(
        props({ onProfileOrderChange }),
      );
      const exitSettings = vi.fn();
      const settingsShortcut = (event: KeyboardEvent) => {
        if (!event.defaultPrevented) {
          exitSettings();
        }
      };
      document.addEventListener("keydown", settingsShortcut);
      pointer(grip, "pointerdown");
      pointer(grip, "pointermove", { x: 40, y: 285 });
      expect(row.style.translate).toBe("20px 210px");
      if (ending === "Escape") {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        expect(exitSettings).not.toHaveBeenCalled();
      } else if (ending === "outside-section" || ending === "other-owner") {
        const rejectedTarget =
          ending === "other-owner"
            ? container.querySelector('[data-profile-id="account:other"]')
            : document.createElement("div");
        if (ending === "outside-section" && rejectedTarget instanceof HTMLElement) {
          rejectedTarget.className = "model-providers__profile";
          rejectedTarget.dataset.profileId = "account:three";
          rejectedTarget.dataset.profileProvider = "credential-owner";
          document.body.append(rejectedTarget);
        }
        hitTest.mockReturnValue(rejectedTarget);
      } else {
        pointer(grip, ending);
      }
      document.removeEventListener("keydown", settingsShortcut);
      pointer(grip, "pointerup", { x: 40, y: 285 });
      expect(onProfileOrderChange).not.toHaveBeenCalled();
      expect(rows.every((candidate) => candidate.style.translate === "")).toBe(true);

      hitTest.mockReturnValue(target);
      pointer(grip, "pointerdown");
      pointer(grip, "pointermove", { x: 40, y: 285 });
      pointer(grip, "pointerup", { x: 40, y: 285 });
      expect(onProfileOrderChange).toHaveBeenCalledExactlyOnceWith(
        "route-one",
        "credential-owner",
        ["account:two", "account:three", "account:one"],
      );
    },
  );

  it("prevents both pointer and keyboard reordering without write access", () => {
    const onProfileOrderChange = vi.fn();
    const { grip } = pointerFixture(props({ canMutate: false, onProfileOrderChange }));
    expect(grip.disabled).toBe(true);
    pointer(grip, "pointerdown");
    pointer(grip, "pointerup");
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("keeps focus on the drag handle through repeated keyboard moves", async () => {
    const providerCard = reorderCard();
    const onProfileOrderChange = vi.fn(
      (_cardId: string, provider: string, order: string[] | null) => {
        if (!order) {
          throw new Error("Expected an account order");
        }
        viewProps = { ...viewProps, profileOrders: { [provider]: order } };
        queueMicrotask(() => render(renderProviderProfiles(providerCard, viewProps), container));
      },
    );
    let viewProps = props({ onProfileOrderChange });
    const container = mount(renderProviderProfiles(providerCard, viewProps));
    const grip = container.querySelector<HTMLButtonElement>(".model-providers__profile-grip")!;
    grip.focus();
    expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(0);
    expect(grip.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");

    for (const order of [
      ["account:two", "account:one", "account:three", "account:other"],
      ["account:two", "account:three", "account:one", "account:other"],
    ]) {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await vi.waitFor(() => {
        expect(
          [...container.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
            (row) => row.dataset.profileId,
          ),
        ).toEqual(order);
        expect(document.activeElement).toBe(grip);
        expect(container.querySelectorAll(".model-providers__profile-position")).toHaveLength(3);
      });
    }
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onProfileOrderChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(grip);
  });
});
