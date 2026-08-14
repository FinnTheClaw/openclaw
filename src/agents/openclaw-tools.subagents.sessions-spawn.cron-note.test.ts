// Verifies cron-isolated sessions suppress run-mode subagent acceptance notes.
import { describe, expect, it } from "vitest";
import {
  resolveSubagentSpawnAcceptedNote,
  SUBAGENT_SPAWN_ACCEPTED_NOTE,
  SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE,
} from "./subagent-spawn-accepted-note.js";

describe("sessions_spawn: cron isolated session note suppression", () => {
  it("suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBeUndefined();
  });

  it("preserves ACCEPTED_NOTE for regular sessions (mode=run)", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:telegram:63448508",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("keeps regular run guidance push-based with cooperative yield", () => {
    // Run-mode children announce completion asynchronously. sessions_yield ends
    // the current model turn without introducing a polling loop.
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("Auto-announce is push-based");
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("Continue any independent work");
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "call sessions_yield when available",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "wait for completion events for ALL required children",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "synthesize one user-visible result with outcomes",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "Continue spawning every worker explicitly requested by the user",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "Never emit NO_REPLY on the original direct user turn",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "NO_REPLY is reserved only for a later completion-event turn",
    );
  });

  it("preserves ACCEPTED_NOTE for non-canonical cron-like keys", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: "agent:main:slack:cron:job:run:uuid",
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("preserves ACCEPTED_NOTE when agentSessionKey is undefined", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "run",
        agentSessionKey: undefined,
      }),
    ).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("uses the session note for cron session-mode spawns", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "session",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBe(SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE);
  });
});
