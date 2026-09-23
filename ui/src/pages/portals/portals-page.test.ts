/* @vitest-environment jsdom */

import type { PortalListResult, PortalSummary } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { resolvePortalUrl } from "./portal-url.ts";

const probePortalReachable = vi.hoisted(() =>
  vi.fn<() => Promise<"reachable" | "unreachable" | "blocked">>(),
);

vi.mock("./portal-reachability.ts", () => ({ probePortalReachable }));

import "./portals-page.ts";

type PortalsPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

const portal = {
  id: "p3000",
  title: "Seeded app",
  port: 3000,
  listenPort: 43_123,
  tokenQuery: "openclaw_portal=secret-token",
  url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
  publicUrl: "http://127.0.0.1:43123/app",
  path: "/app",
  description: "Use the seeded test account.",
  createdAtMs: 1_000,
} satisfies PortalSummary;

function createContext(
  methods: string[],
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const requestMock = vi.fn(request);
  const client = { request: requestMock } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(methods, ["operator.write"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "wss://gateway.example.test:18789/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    context: { gateway } as unknown as ApplicationContext,
    emitPortals(portals: PortalSummary[]) {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "portal.changed", payload: { portals } });
      }
    },
    request: requestMock,
  };
}

async function mountPage(context: ApplicationContext) {
  const page = document.createElement("openclaw-portals-page") as PortalsPageTestElement;
  page.context = context;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

beforeEach(() => {
  probePortalReachable.mockReset().mockResolvedValue("reachable");
});

describe("PortalsPage", () => {
  it("renders the portal list and refetches it after replacement events", async () => {
    const source = createContext(["portal.list", "portal.close"], async (method) => {
      if (method === "portal.list") {
        return { portals: [portal] } satisfies PortalListResult;
      }
      return { closed: true };
    });
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
    });
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain("Port 3000");
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain(
      "Use the seeded test account.",
    );
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      "https://gateway.example.test:43123/app?openclaw_portal=secret-token",
    );
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
    expect(probePortalReachable).toHaveBeenCalledWith(
      "https://gateway.example.test:43123/app?openclaw_portal=secret-token",
    );

    source.emitPortals([]);

    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledTimes(2);
    });
    expect(source.request).toHaveBeenLastCalledWith("portal.list", {});
    expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
  });

  it("requires write access instead of opening a portal without credentials", async () => {
    const { tokenQuery: _tokenQuery, url: _url, ...redactedPortal } = portal;
    const source = createContext(["portal.list"], async () => ({
      portals: [redactedPortal as PortalSummary],
    }));
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.textContent).toContain("This portal requires an operator with write access.");
    });
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.querySelector(".portals-preview__url")).toBeNull();
    expect(probePortalReachable).not.toHaveBeenCalled();
  });

  it("shows an unreachable notice without mounting the iframe and retries", async () => {
    probePortalReachable.mockResolvedValueOnce("unreachable").mockResolvedValueOnce("reachable");
    const source = createContext(["portal.list", "portal.close"], async (method) => {
      if (method === "portal.list") {
        return { portals: [portal] } satisfies PortalListResult;
      }
      return { closed: true };
    });
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Portal not reachable from this browser");
    });
    expect(page.querySelector("iframe")).toBeNull();

    page.querySelector<HTMLButtonElement>(".portals-preview__close")?.click();
    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledWith("portal.close", { id: portal.id });
    });

    const retry = [...page.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry?.click();

    await vi.waitFor(() => expect(page.querySelector("iframe")).not.toBeNull());
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it("still mounts the preview when policy blocks the probe", async () => {
    // A CSP-refused probe never reached the network, so it must not be reported
    // as an unreachable portal: frames obey frame-src and can still load.
    probePortalReachable.mockResolvedValue("blocked");
    const source = createContext(["portal.list", "portal.close"], async () => ({
      portals: [portal],
    }));
    const page = await mountPage(source.context);

    await vi.waitFor(() => expect(page.querySelector("iframe")).not.toBeNull());
    expect(page.textContent).not.toContain("Portal not reachable from this browser");
  });

  it("shows the empty prompts and an unsupported note without calling the method", async () => {
    const source = createContext([], async () => ({ portals: [] }));
    const page = await mountPage(source.context);

    expect(page.textContent).toContain("Ask the agent to start a portal:");
    expect(page.textContent).toContain("Show me in a portal.");
    expect(page.textContent).toContain("Start the application in a portal.");
    expect(page.textContent).toContain("Make the server available in a portal.");
    expect(page.textContent).toContain("This gateway does not support portals.");
    expect(source.request).not.toHaveBeenCalled();
  });

  it("refetches when a portal change arrives during an in-flight list", async () => {
    let resolveFirst!: (result: PortalListResult) => void;
    let listCalls = 0;
    const source = createContext(["portal.list"], async () => {
      listCalls += 1;
      return listCalls === 1
        ? await new Promise<PortalListResult>((resolve) => {
            resolveFirst = resolve;
          })
        : ({ portals: [portal] } satisfies PortalListResult);
    });
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));

    source.emitPortals([portal]);
    source.emitPortals([portal]);
    resolveFirst({ portals: [] });

    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledTimes(2);
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
    });
  });
});

describe("checkpoint R9 portals refresh cases", () => {
  const secondPortal = { ...portal, id: "p4000", title: "Second app", port: 4000 };

  function deferredList() {
    let resolve!: (value: PortalListResult) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<PortalListResult>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    return { promise, resolve, reject };
  }

  it("R9-PORTALS-REFRESH-01 initial connected load displays portal set", async () => {
    const source = createContext(["portal.list"], async () => ({ portals: [portal] }));
    const page = await mountPage(source.context);
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app"),
    );
    expect(source.request).toHaveBeenCalledTimes(1);
  });

  it("R9-PORTALS-REFRESH-02 idle change starts a fresh list", async () => {
    let calls = 0;
    const source = createContext(["portal.list"], async () => ({
      portals: ++calls === 1 ? [] : [portal],
    }));
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    source.emitPortals([portal]);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app"),
    );
  });

  it("R9-PORTALS-REFRESH-03 change during first list triggers a fresh visible set", async () => {
    const first = deferredList();
    let calls = 0;
    const source = createContext(["portal.list"], async () =>
      ++calls === 1 ? first.promise : { portals: [portal] },
    );
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    source.emitPortals([portal]);
    first.resolve({ portals: [] });
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app"),
    );
  });

  it("R9-PORTALS-REFRESH-04 several changes during one list coalesce to one follow-up", async () => {
    const first = deferredList();
    let calls = 0;
    const source = createContext(["portal.list"], async () =>
      ++calls === 1 ? first.promise : { portals: [portal] },
    );
    await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    source.emitPortals([portal]);
    source.emitPortals([portal]);
    source.emitPortals([portal]);
    first.resolve({ portals: [] });
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.request).toHaveBeenCalledTimes(2);
  });

  it("R9-PORTALS-REFRESH-05 a change during follow-up schedules a third list", async () => {
    const first = deferredList();
    const second = deferredList();
    let calls = 0;
    const source = createContext(["portal.list"], async () => {
      calls += 1;
      return calls === 1
        ? first.promise
        : calls === 2
          ? second.promise
          : { portals: [secondPortal] };
    });
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    source.emitPortals([portal]);
    first.resolve({ portals: [] });
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    source.emitPortals([secondPortal]);
    second.resolve({ portals: [portal] });
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Second app"),
    );
  });

  it("R9-PORTALS-REFRESH-06 disconnect prevents stale list publication", async () => {
    const first = deferredList();
    const source = createContext(["portal.list"], async () => first.promise);
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    page.remove();
    first.resolve({ portals: [portal] });
    await page.updateComplete;
    expect(page.querySelector(".portals-rail__title")).toBeNull();
  });

  it("R9-PORTALS-REFRESH-07 reconnect loads only the new gateway client data", async () => {
    const oldList = deferredList();
    const oldSource = createContext(["portal.list"], async () => oldList.promise);
    const newSource = createContext(["portal.list"], async () => ({ portals: [secondPortal] }));
    const page = await mountPage(oldSource.context);
    await vi.waitFor(() => expect(oldSource.request).toHaveBeenCalledTimes(1));
    page.remove();
    page.context = newSource.context;
    document.body.append(page);
    await vi.waitFor(() => expect(newSource.request).toHaveBeenCalledTimes(1));
    oldList.resolve({ portals: [portal] });
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Second app"),
    );
  });

  it("R9-PORTALS-REFRESH-08 selection persists when refreshed set retains its ID", async () => {
    let calls = 0;
    const source = createContext(["portal.list"], async () => ({
      portals: ++calls === 1 ? [portal, secondPortal] : [secondPortal, portal],
    }));
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(page.querySelectorAll(".portals-rail__item")).toHaveLength(2));
    (page.querySelectorAll(".portals-rail__item")[1] as HTMLElement).click();
    source.emitPortals([secondPortal, portal]);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        page.querySelector(".portals-rail__item.active .portals-rail__title")?.textContent,
      ).toBe("Second app"),
    );
  });

  it("R9-PORTALS-REFRESH-09 selection falls back when refreshed set removes selected ID", async () => {
    let calls = 0;
    const source = createContext(["portal.list"], async () => ({
      portals: ++calls === 1 ? [portal, secondPortal] : [portal],
    }));
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(page.querySelectorAll(".portals-rail__item")).toHaveLength(2));
    (page.querySelectorAll(".portals-rail__item")[1] as HTMLElement).click();
    source.emitPortals([portal]);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        page.querySelector(".portals-rail__item.active .portals-rail__title")?.textContent,
      ).toBe("Seeded app"),
    );
  });

  it("R9-PORTALS-REFRESH-10 queued refresh recovers after first list rejects", async () => {
    const first = deferredList();
    let calls = 0;
    const source = createContext(["portal.list"], async () =>
      ++calls === 1 ? first.promise : { portals: [portal] },
    );
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(1));
    source.emitPortals([portal]);
    first.reject(new Error("stale failure"));
    await vi.waitFor(() => expect(source.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app"),
    );
    expect(page.textContent).not.toContain("stale failure");
  });
});

describe("resolvePortalUrl", () => {
  it("uses the resolved gateway host and scheme with the portal listener port", () => {
    expect(
      resolvePortalUrl(
        portal,
        "wss://gateway.example.test:18789/control",
        "http://control-ui.example.test",
      ),
    ).toBe("https://gateway.example.test:43123/app?openclaw_portal=secret-token");
  });
});
