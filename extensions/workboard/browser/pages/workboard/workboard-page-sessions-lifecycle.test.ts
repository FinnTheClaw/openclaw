import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardSessionsBoardRead } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { button, sessionsPage } from "./workboard-page-sessions.test-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

it("refreshes loaded Sessions rows after a live change during the next page", async () => {
  const page = sessionsPage();
  const first = expectDefined(page.result.sessions[0], "first session");
  const tail = {
    ...structuredClone(page.result),
    sessions: page.result.sessions.slice(1),
    total: 2,
  };
  const pendingPage = createDeferred<WorkboardSessionsBoardRead>();
  const request = expectDefined(page.request.getMockImplementation(), "request");
  let cursors = 0;
  page.request.mockImplementation(async (method, params) => {
    if (method !== "workboard.sessionsBoard.read") {
      return request(method, params);
    }
    // SAFETY: this fixture handles the documented Sessions board request contract.
    const input = params as { after?: string };
    if (input.after) {
      return ++cursors === 1 ? pendingPage.promise : tail;
    }
    return {
      ...structuredClone(page.result),
      sessions: [structuredClone(first)],
      total: 2,
      nextCursor: first.key,
    };
  });
  await page.connect();
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(1);
  button(page, "Load more sessions").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
    after: first.key,
  });

  first.label = "Canonical renamed session";
  page.fixture.emit("plugin.workboard.changed", { epoch: "facts", revision: 2 });
  await vi.advanceTimersByTimeAsync(0);
  pendingPage.resolve(tail);
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(2);
  expect(page.container.textContent).toContain("Canonical renamed session");
  expect(page.reads()).toBe(4);
});

it("keeps newer Workboard navigation when board creation settles after the route changes", async () => {
  const page = sessionsPage();
  const savedBoard = { id: "created-cards", name: "Created board", createdAt: 1, updatedAt: 1 };
  const create = createDeferred<{ board: typeof savedBoard }>();
  const destination = { id: "other-board", name: "Other board" };
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.boards.upsert") {
      return create.promise;
    }
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: [page.board, destination].map((board) => ({
          ...board,
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
        })),
      };
    }
    return request(method, params);
  });

  await page.connect();
  button(page, "New board").click();
  await vi.advanceTimersByTimeAsync(0);
  const form = expectDefined(
    page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "new board",
  );
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "board name",
  );
  name.value = savedBoard.name;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
    id: expect.stringMatching(/^board-/),
    name: savedBoard.name,
  });
  expect(page.registerBoardNavigation).not.toHaveBeenCalled();

  page.navigate(destination.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(page.workboard.state.boardFilter).toBe(destination.id);
  expect(page.fixture.host.navigation.openPage).not.toHaveBeenCalled();

  create.resolve({ board: savedBoard });
  await vi.advanceTimersByTimeAsync(0);
  expect(page.registerBoardNavigation).toHaveBeenCalledExactlyOnceWith(savedBoard);
  expect(page.fixture.host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-created-cards");
  expect(page.container.querySelector(".workboard-board-draft")).toBeNull();
  expect(page.fixture.host.navigation.openPage).not.toHaveBeenCalled();
});
