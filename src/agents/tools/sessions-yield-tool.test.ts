// sessions_yield tool tests cover cooperative turn yielding and unsupported
// context errors.
import { describe, expect, it, vi } from "vitest";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

type SessionsYieldDetails = {
  status?: string;
  message?: string;
  error?: string;
};

describe("sessions_yield tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      validateYield: () => null,
      onYield,
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Turn yielded.");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("passes the custom message through the yield callback", async () => {
    // The callback message becomes operator-visible scheduler context, so the
    // tool must not replace a supplied reason with the default text.
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      validateYield: () => null,
      onYield,
    });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Waiting for fact-checker");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("fails closed when the runtime rejects a leaf yield", async () => {
    const onYield = vi.fn();
    const validateYield = vi
      .fn()
      .mockResolvedValue("sessions_yield requires at least one pending descendant subagent");
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      validateYield,
      onYield,
    });

    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;

    expect(details.status).toBe("error");
    expect(details.error).toContain("pending descendant");
    expect(validateYield).toHaveBeenCalledOnce();
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield after runtime validation succeeds", async () => {
    const onYield = vi.fn();
    const validateYield = vi.fn().mockResolvedValue(null);
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      validateYield,
      onYield,
    });

    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;

    expect(details.status).toBe("yielded");
    expect(validateYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });

  it("fails closed when an onYield callback lacks an admission validator", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });

    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;

    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield admission is unavailable in this context");
    expect(onYield).not.toHaveBeenCalled();
  });
});
