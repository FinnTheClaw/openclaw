import { ContextProvider } from "@lit/context";
import { createRouter } from "@openclaw/uirouter";
import { html, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../app/router-outlet.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { inspectResult, manifest } from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import { skillWorkshopRevisionAdmissionsFor } from "./revision-recovery.ts";
import { page as skillWorkshopRoute } from "./route.ts";
import "./skill-workshop-page.ts";
import {
  createContext,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";

beforeEach(() => {
  localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "suggestions");
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("Workshop route refresh", () => {
  it("L02-102-F01 scopes retained recovery while the same page selects A then B then A", async () => {
    const listeners = new Set<() => void>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      const agentId = (params as { agentId?: string } | undefined)?.agentId ?? "research";
      if (method === "skills.proposals.list") {
        const result = manifest();
        return {
          ...result,
          proposals: result.proposals.map((proposal) => ({
            ...proposal,
            id: "proposal-" + agentId,
            title: agentId + " suggestion",
            skillKey: "inbox-" + agentId,
          })),
        };
      }
      if (method === "skills.proposals.inspect") {
        const result = inspectResult();
        return {
          ...result,
          record: {
            ...result.record,
            id: "proposal-" + agentId,
            title: agentId + " suggestion",
            origin: { agentId, sessionKey: "agent:" + agentId + ":workshop" },
            target: { skillName: agentId + " suggestion", skillKey: "inbox-" + agentId },
          },
        };
      }
      throw new Error("Unexpected Workshop request: " + method);
    });
    const context = createContext(request, {
      methods: [
        "skills.proposals.list",
        "skills.proposals.inspect",
        "skills.proposals.requestRevision",
      ],
      agentSelectionSubscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    let selectedId = "research";
    const selection = context.agentSelection.state;
    Object.defineProperty(context.agentSelection, "state", {
      get: () => ({ ...selection, selectedId, scopeId: selectedId }),
    });
    const admissions = skillWorkshopRevisionAdmissionsFor(context);
    const instructions = "  Preserve A's exact retry instructions.\nKeep this second line.\n";
    const executor = vi.fn(async () => {
      throw new Error("A admission failed");
    });
    const failed = admissions.start(
      {
        instructions,
        proposalAgentId: "research",
        proposalId: "proposal-research",
        proposalSlug: "inbox-research",
        expectedRevisionHash: inspectResult().revisionHash,
      },
      executor,
    );
    await failed.completion;
    const retained = admissions.get(failed.entry.id);
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = context;
    document.body.append(page);

    try {
      await settleLitElement(page);
      const initial = {
        connected: page.isConnected,
        agent: page.state?.skillWorkshopAgentId,
        proposals: page.state?.skillWorkshopProposals.map((proposal) => proposal.key),
        key: page.state?.skillWorkshopRevisionKey,
        draft: page.state?.skillWorkshopRevisionDraft,
        visibleDraft: page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input")?.value,
        failed: retained?.phase,
        instructions: retained?.instructions,
        hasIdempotency: Boolean(retained?.idempotencyKey),
      };

      selectedId = "ops";
      for (const listener of listeners) {
        listener();
      }
      await settleLitElement(page);
      const revise = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Revise",
      );
      const reviseAvailable = Boolean(revise && !revise.disabled);
      revise?.click();
      await settleLitElement(page);
      const input = page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input");
      const editable = Boolean(input && !input.disabled);
      const bInstructions = "Only B's new revision draft.";
      if (input) {
        input.value = bInstructions;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settleLitElement(page);
      }
      const onB = {
        sameMountedPage: page.isConnected && document.body.contains(page),
        agent: page.state?.skillWorkshopAgentId,
        proposals: page.state?.skillWorkshopProposals.map((proposal) => proposal.key),
        reviseAvailable,
        key: page.state?.skillWorkshopRevisionKey,
        draft: page.state?.skillWorkshopRevisionDraft,
        editable,
        visibleDraft: page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input")?.value,
        error: page.state?.skillWorkshopError,
        retainedA: admissions.get(failed.entry.id),
        failedB: admissions.firstFailed("ops"),
        executorCalls: executor.mock.calls.length,
      };

      selectedId = "research";
      for (const listener of listeners) {
        listener();
      }
      await settleLitElement(page);
      const returnedA = {
        sameMountedPage: page.isConnected && document.body.contains(page),
        agent: page.state?.skillWorkshopAgentId,
        key: page.state?.skillWorkshopRevisionKey,
        draft: page.state?.skillWorkshopRevisionDraft,
        visibleDraft: page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input")?.value,
        failureVisible: page.state?.skillWorkshopError?.includes("A admission failed") ?? false,
        retained: admissions.get(failed.entry.id),
        executorCalls: executor.mock.calls.length,
        revisionRequests: request.mock.calls.filter(
          ([method]) => method === "skills.proposals.requestRevision",
        ).length,
        listAgents: request.mock.calls
          .filter(([method]) => method === "skills.proposals.list")
          .map(([, params]) => (params as { agentId: string }).agentId),
      };

      expect({ initial, onB, returnedA }).toEqual({
        initial: {
          connected: true,
          agent: "research",
          proposals: ["proposal-research"],
          key: "proposal-research",
          draft: instructions,
          visibleDraft: instructions,
          failed: "retryable-failed",
          instructions,
          hasIdempotency: true,
        },
        onB: {
          sameMountedPage: true,
          agent: "ops",
          proposals: ["proposal-ops"],
          reviseAvailable: true,
          key: "proposal-ops",
          draft: bInstructions,
          editable: true,
          visibleDraft: bInstructions,
          error: null,
          retainedA: retained,
          failedB: null,
          executorCalls: 1,
        },
        returnedA: {
          sameMountedPage: true,
          agent: "research",
          key: "proposal-research",
          draft: instructions,
          visibleDraft: instructions,
          failureVisible: true,
          retained,
          executorCalls: 1,
          revisionRequests: 0,
          listAgents: ["research", "ops", "research"],
        },
      });
    } finally {
      page.remove();
      await failed.completion;
      admissions.dispose();
    }
  });

  it("loads proposals before restoring a retained failed revision on mount", async () => {
    const response = createDeferred<ReturnType<typeof manifest>>();
    const request = vi.fn(async (method: string) =>
      method === "skills.proposals.list" ? response.promise : inspectResult(),
    );
    const context = createContext(request, {
      methods: ["skills.proposals.list", "skills.proposals.inspect"],
    });
    const instructions = "Preserve these revision instructions after returning.";
    await skillWorkshopRevisionAdmissionsFor(context).start(
      {
        instructions,
        proposalAgentId: "research",
        proposalId: "proposal-1",
        proposalSlug: "inbox-cleaner",
      },
      async () => {
        throw new Error("Revision admission failed");
      },
    ).completion;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = context;
    document.body.append(page);
    try {
      await settleLitElement(page);
      expect(
        request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
      ).toHaveLength(1);
      expect(page.state?.skillWorkshopRevisionDraft).toBe(instructions);
      expect(page.state?.skillWorkshopError).toContain("Revision admission failed");
      response.resolve(manifest());
      await settleLitElement(page);
      expect(page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input")?.value).toBe(
        instructions,
      );
      expect(
        request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
      ).toHaveLength(1);
    } finally {
      response.resolve(manifest());
      page.remove();
      skillWorkshopRevisionAdmissionsFor(context).dispose();
    }
  });

  it.each(["created", "stale"] as const)(
    "shows a %s proposal change on the first warm return to Workshop",
    async (change) => {
      const refreshing = createDeferred();
      const response = createDeferred<ReturnType<typeof manifest>>();
      let refreshingRoute = false;
      const request = vi.fn(async (method: string) => {
        if (method === "skills.proposals.list") {
          if (!refreshingRoute) {
            return change === "created"
              ? { ...manifest(), proposals: [], installedSkills: [] }
              : manifest();
          }
          refreshing.resolve();
          return response.promise;
        }
        if (method === "skills.proposals.inspect") {
          return inspectResult(change === "stale" && refreshingRoute ? "stale" : "pending");
        }
        return {};
      });
      const context = createContext(request, {
        methods: ["skills.proposals.list", "skills.proposals.inspect", "skills.proposals.apply"],
      });
      const router = createRouter({
        routes: [
          skillWorkshopRoute,
          { id: "other", path: "/other", component: () => ({ render: () => html`` }) },
        ],
      });
      const host = document.createElement("openclaw-router-outlet") as LitElement & {
        router: typeof router;
        retryContext: ApplicationContext;
      };
      host.router = router;
      host.retryContext = context;
      const contextProvider = new ContextProvider(host, { context: applicationContext });
      contextProvider.setValue(context);
      document.body.append(host);
      try {
        await router.navigate("skill-workshop", context);
        await settleLitElement(host);
        const initial = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        )!;
        await settleLitElement(initial);
        expect(initial.querySelectorAll(".sw-row")).toHaveLength(change === "created" ? 0 : 1);
        await router.navigate("other", context);
        await settleLitElement(host);
        const initialLists = request.mock.calls.filter(
          ([method]) => method === "skills.proposals.list",
        ).length;
        refreshingRoute = true;
        const returning = router.navigate("skill-workshop", context);
        await refreshing.promise;
        await settleLitElement(host);
        const cached = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        );
        if (cached) {
          await settleLitElement(cached);
        }
        response.resolve(manifest(change === "stale" ? "stale" : "pending"));
        await returning;
        await settleLitElement(host);
        const current = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        )!;
        await settleLitElement(current);
        expect(
          request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
        ).toHaveLength(initialLists + 1);
        expect(current.querySelectorAll(".sw-row")).toHaveLength(change === "created" ? 1 : 0);
        expect(current.querySelector(".sw-action-bar .sw-btn--primary") !== null).toBe(
          change === "created",
        );
      } finally {
        response.resolve(manifest());
        host.remove();
        router.stop();
      }
    },
  );
});
