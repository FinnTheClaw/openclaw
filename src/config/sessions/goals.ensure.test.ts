import { describe, expect, it } from "vitest";
import { ensureSessionGoal, updateSessionGoalStatus } from "./goals.js";
import { upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("ensureSessionGoal", () => {
  const fixture = useTempSessionsFixture("openclaw-session-goal-ensure-");
  const sessionKey = "agent:main:signal:direct:123";

  async function writeSession() {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });
  }

  it("atomically reuses an active goal for a substantive follow-up", async () => {
    await writeSession();
    const created = await ensureSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "first substantive request",
      now: 10,
    });
    const reused = await ensureSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "follow-up wording must not replace active work",
      now: 20,
    });

    expect(created.disposition).toBe("created");
    expect(reused.disposition).toBe("reused");
    expect(reused.goal.id).toBe(created.goal.id);
    expect(reused.goal.objective).toBe("first substantive request");
  });

  it("replaces a completed goal with the next substantive request", async () => {
    await writeSession();
    const first = await ensureSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "first",
      now: 10,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      now: 20,
    });
    const next = await ensureSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "second",
      now: 30,
    });

    expect(next.disposition).toBe("replaced_completed");
    expect(next.goal.id).not.toBe(first.goal.id);
    expect(next.goal.objective).toBe("second");
  });

  it("converges concurrent substantive admission on one goal", async () => {
    await writeSession();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ensureSessionGoal({
          storePath: fixture.storePath(),
          sessionKey,
          objective: `request ${index}`,
          now: 10 + index,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.goal.id)).size).toBe(1);
    expect(results.filter((result) => result.disposition === "created")).toHaveLength(1);
  });
});
