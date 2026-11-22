import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import { vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

export function sessionsPage(
  options: { boardId?: string; gatewayId?: string; profileId?: string } = {},
) {
  const board: WorkboardSessionsBoard = {
    id: options.boardId ?? "sessions",
    name: "Team sessions",
    kind: "sessions",
    createdAt: 1,
    updatedAt: 1,
    sessions: {
      columns: [
        {
          id: "working",
          label: "Working",
          description: "Active work",
          color: "blue",
          match: { run: ["active"] },
        },
        { id: "done", label: "Done", description: "Completed work", fallback: true },
      ],
    },
  };
  const result: WorkboardSessionsBoardRead = {
    board,
    columns: board.sessions.columns,
    people: [
      { identity: { type: "profile", id: "viewer" }, label: "Viewer", sessionCount: 2 },
      { identity: { type: "profile", id: "ada" }, label: "Ada", sessionCount: 1 },
      { identity: { type: "profile", id: "grace" }, sessionCount: 1 },
    ],
    sessions: [
      {
        key: "agent:main:working",
        sessionId: "working-id",
        agentId: "main",
        label: "Fix retries",
        run: "active",
        observerDigest: { health: "on-track", headline: "Checking reconnects", revision: 2 },
        pullRequests: [{ number: 42, state: "open" }],
        archived: false,
        lastActivityAt: Date.now() - 120_000,
        columnId: "working",
        source: "state",
        reason: "Active run",
      },
      {
        key: "agent:writer:done",
        sessionId: "done-id",
        agentId: "writer",
        derivedTitle: "Write release guide",
        run: "idle",
        pullRequests: [{ number: 43, state: "merged" }],
        archived: false,
        lastActivityAt: Date.now() - 60_000,
        columnId: "done",
        source: "operator",
        reason: "Reviewed",
      },
    ],
    warning:
      "Session facts are unavailable for 2 sessions: Gateway disconnected. Showing the last known placement.",
  };
  const page = mountPage({ boardId: board.id });
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "gateway.identity.get") {
      return { deviceId: options.gatewayId ?? "gateway-one" };
    }
    if (method === "users.self") {
      return { profile: { id: options.profileId ?? "viewer" } };
    }
    if (method === "workboard.cards.list") {
      return { cards: [], boards: [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }] };
    }
    if (method === "workboard.sessionsBoard.read") {
      return structuredClone(result);
    }
    return request(method, params);
  });
  return {
    ...page,
    board,
    result,
    async connect() {
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.advanceTimersByTimeAsync(0);
    },
    reads() {
      return page.request.mock.calls.filter(([method]) => method === "workboard.sessionsBoard.read")
        .length;
    },
  };
}

export function button(page: ReturnType<typeof sessionsPage>, label: string) {
  return expectDefined(
    [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    ),
    label,
  );
}
