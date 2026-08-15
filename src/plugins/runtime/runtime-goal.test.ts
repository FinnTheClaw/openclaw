import { describe, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../../config/sessions/store.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createRuntimeGoals } from "./runtime-goal.js";

describe("plugin runtime goals", () => {
  const fixture = useTempSessionsFixture("openclaw-runtime-goals-");

  it("exposes atomic core Goal admission without TaskFlow authority", async () => {
    const sessionKey = "agent:finn:signal:direct:test";
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: { sessionId: "session-1", updatedAt: 1 },
    });
    const runtime = createRuntimeGoals({ storePath: fixture.storePath() });

    const created = await runtime.ensure({ sessionKey, objective: "substantive work" });
    const reused = await runtime.ensure({ sessionKey, objective: "follow-up" });

    expect(created.disposition).toBe("created");
    expect(reused.disposition).toBe("reused");
    expect(reused.goal.id).toBe(created.goal.id);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.id).toBe(
      created.goal.id,
    );
  });
});
