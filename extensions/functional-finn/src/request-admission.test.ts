import { describe, expect, it, vi } from "vitest";
import { createFunctionalFinnAdmission } from "./request-admission.js";

const config = {
  agentIds: ["finn"],
  channels: ["signal"],
  verifierSocketPath: "/tmp/verifier.sock",
  verifierTimeoutMs: 500,
} as const;

describe("Functional Finn Goal admission", () => {
  it("leaves trivial conversation lightweight", async () => {
    const ensureGoal = vi.fn();
    const admit = createFunctionalFinnAdmission({ config, ensureGoal });

    await expect(
      admit({ prompt: "Thanks!" }, { agentId: "finn", channel: "signal" }),
    ).resolves.toEqual({ outcome: "pass" });
    expect(ensureGoal).not.toHaveBeenCalled();
  });

  it("creates a content-free durable Goal identity for substantive work", async () => {
    const ensureGoal = vi.fn().mockResolvedValue(undefined);
    const admit = createFunctionalFinnAdmission({ config, ensureGoal });
    const privatePrompt = "Inspect private host alpha and repair service beta";

    await expect(
      admit(
        { prompt: privatePrompt },
        { agentId: "finn", channel: "signal", sessionKey: "agent:finn:signal:one" },
      ),
    ).resolves.toEqual({ outcome: "pass" });
    expect(ensureGoal).toHaveBeenCalledTimes(1);
    const stored = ensureGoal.mock.calls[0]?.[0];
    expect(stored.sessionKey).toBe("agent:finn:signal:one");
    expect(stored.objective).toMatch(
      /^Complete substantive user request \[sha256:[a-f0-9]{16}\]$/u,
    );
    expect(JSON.stringify(stored)).not.toContain(privatePrompt);
    expect(JSON.stringify(stored)).not.toContain("alpha");
  });

  it("fails closed when substantive work has no durable session", async () => {
    const ensureGoal = vi.fn();
    const admit = createFunctionalFinnAdmission({ config, ensureGoal });

    await expect(
      admit({ prompt: "Inspect the service" }, { agentId: "finn", channel: "signal" }),
    ).resolves.toMatchObject({ outcome: "block" });
    expect(ensureGoal).not.toHaveBeenCalled();
  });

  it("does not govern unconfigured agents or channels", async () => {
    const ensureGoal = vi.fn();
    const admit = createFunctionalFinnAdmission({ config, ensureGoal });

    await admit(
      { prompt: "Inspect the service" },
      { agentId: "other", channel: "signal", sessionKey: "session" },
    );
    await admit(
      { prompt: "Inspect the service" },
      { agentId: "finn", channel: "discord", sessionKey: "session" },
    );
    expect(ensureGoal).not.toHaveBeenCalled();
  });
});
