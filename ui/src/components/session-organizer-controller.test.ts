import { describe, expect, it, vi } from "vitest";
import { SESSION_DRAG_MIME } from "../lib/sessions/drag.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";

describe("SessionOrganizerController session-list removal hover", () => {
  it("uses the dragstart session key when browsers protect dragover payloads", () => {
    const session = { key: "agent:main:pinned", pinned: true };
    const host = {
      requestUpdate: vi.fn(),
      findSidebarSessionByKey: (key: string) => (key === session.key ? session : undefined),
    };
    const controller = new SessionOrganizerController(host as never);
    controller.startSessionDrag(session as never);
    const event = new Event("dragover", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: [SESSION_DRAG_MIME], getData: () => "", dropEffect: "none" },
    });

    controller.handleSessionListDragOver(event as DragEvent);

    expect(event.defaultPrevented).toBe(true);
    expect(controller.sessionListRemovalDrop).toBe(true);
  });

  it("does not activate removal for a non-session protected drag", () => {
    const host = { requestUpdate: vi.fn(), findSidebarSessionByKey: vi.fn() };
    const controller = new SessionOrganizerController(host as never);
    controller.draggingSessionKey = "agent:main:pinned";
    const event = new Event("dragover", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["text/plain"], getData: () => "", dropEffect: "none" },
    });

    controller.handleSessionListDragOver(event as DragEvent);

    expect(event.defaultPrevented).toBe(false);
    expect(controller.sessionListRemovalDrop).toBe(false);
  });
});
