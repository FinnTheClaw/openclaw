import { describe, expect, it } from "vitest";
import { createCodexSupervisionTools } from "./supervision-tools.js";

type Options = Parameters<typeof createCodexSupervisionTools>[0];
type Request = NonNullable<Options["request"]>;
type RequestArgs = Parameters<Request>;
type Handler = (...args: RequestArgs) => unknown | Promise<unknown>;
type Call = { endpointId: string; method: string; params: unknown };

const THREAD_ID = "thread-lookup-cp90";

function configFor(ids: string[]) {
  return {
    supervision: {
      enabled: true,
      allowRawTranscripts: true,
      allowWriteControls: true,
      endpoints: ids.map((id) => ({ id, transport: "stdio-proxy" as const })),
    },
  };
}

function makeTools(ids: string[], handler: Handler, getConfig?: () => unknown) {
  const calls: Call[] = [];
  const request: Request = async <T>(endpoint, method, params) => {
    calls.push({ endpointId: endpoint.id, method, params });
    return (await handler(endpoint, method, params)) as T;
  };
  const tools = createCodexSupervisionTools({
    getPluginConfig: getConfig ?? (() => configFor(ids)),
    senderIsOwner: true,
    env: {},
    request,
  });
  const tool = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) {
      throw new Error("Missing supervision tool: " + name);
    }
    return found;
  };
  return { calls, tool };
}

function thread(status: "idle" | "active" = "idle") {
  return {
    thread: {
      id: THREAD_ID,
      status: { type: status },
      turns: status === "active" ? [{ id: "turn-1", status: "inProgress" }] : [],
    },
  };
}

describe("CP90 Codex supervision endpoint lookup diagnostics", () => {
  it("CP90-CODEX01 routes a unique implicit read through its matching endpoint", async () => {
    const { calls, tool } = makeTools(["only"], (_endpoint, method) => {
      expect(method).toBe("thread/read");
      return thread();
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).resolves.toMatchObject({ details: { summary: "codex session: " + THREAD_ID } });
    expect(calls.map((call) => [call.endpointId, call.method])).toEqual([
      ["only", "thread/read"],
      ["only", "thread/read"],
    ]);
  });

  it("CP90-CODEX02 reports not found when two endpoints prove a read miss", async () => {
    const { calls, tool } = makeTools(["first", "second"], () => {
      throw new Error("thread not found");
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread not found: " + THREAD_ID);
    expect(calls.map((call) => call.endpointId)).toEqual(["first", "second"]);
  });

  it("CP90-CODEX03 treats a known not-loaded miss as a definite miss", async () => {
    const { calls, tool } = makeTools(["only"], () => {
      throw new Error("thread not loaded");
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread not found: " + THREAD_ID);
    expect(calls).toHaveLength(1);
  });

  it("CP90-CODEX04 does not call a sole timeout a definite absence", async () => {
    const { calls, tool } = makeTools(["only"], () => {
      throw new Error("Codex request timed out");
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread lookup incomplete");
    expect(calls).toHaveLength(1);
  });

  it("CP90-CODEX05 does not call connection refusal a definite absence", async () => {
    const { calls, tool } = makeTools(["only"], () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread lookup incomplete");
    expect(calls).toHaveLength(1);
  });

  it("CP90-CODEX06 remains unresolved with one failed endpoint and one proven miss", async () => {
    const { calls, tool } = makeTools(["failed", "missing"], (endpoint) => {
      throw new Error(endpoint.id === "failed" ? "Codex request timed out" : "thread not found");
    });
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread lookup incomplete");
    expect(calls.map((call) => call.endpointId)).toEqual(["failed", "missing"]);
  });

  it("CP90-CODEX07 preserves a unique successful send despite another endpoint failure", async () => {
    const { calls, tool } = makeTools(["failed", "owner"], (endpoint, method) => {
      if (endpoint.id === "failed") {
        throw new Error("Codex request timed out");
      }
      if (method === "thread/read") {
        return thread("active");
      }
      if (method === "turn/steer") {
        return {};
      }
      throw new Error("Unexpected method: " + method);
    });
    await expect(
      tool("codex_session_send").execute("send", {
        thread_id: THREAD_ID,
        text: "continue",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex steer: turn-1" } });
    expect(calls.map((call) => [call.endpointId, call.method])).toEqual([
      ["failed", "thread/read"],
      ["owner", "thread/read"],
      ["owner", "thread/read"],
      ["owner", "turn/steer"],
    ]);
  });

  it("CP90-CODEX08 preserves ambiguity when two endpoints positively match", async () => {
    const { calls, tool } = makeTools(["first", "second"], () => thread());
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex thread id is ambiguous across endpoints: " + THREAD_ID);
    expect(calls.map((call) => call.endpointId)).toEqual(["first", "second"]);
  });

  it("CP90-CODEX09 keeps explicit endpoint interrupt independent of other endpoints", async () => {
    const { calls, tool } = makeTools(["offline", "chosen"], (endpoint, method) => {
      if (endpoint.id === "offline") {
        throw new Error("ECONNREFUSED");
      }
      if (method === "thread/read") {
        return thread("active");
      }
      if (method === "turn/interrupt") {
        return {};
      }
      throw new Error("Unexpected method: " + method);
    });
    await expect(
      tool("codex_session_interrupt").execute("interrupt", {
        endpoint_id: "chosen",
        thread_id: THREAD_ID,
        turn_id: "turn-1",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex interrupted: turn-1" } });
    expect(calls.map((call) => [call.endpointId, call.method])).toEqual([
      ["chosen", "thread/read"],
      ["chosen", "turn/interrupt"],
    ]);
  });

  it("CP90-CODEX10 propagates policy revocation during implicit lookup", async () => {
    let current: unknown = configFor(["first", "second"]);
    const { calls, tool } = makeTools(
      ["first", "second"],
      () => {
        current = { supervision: { enabled: false } };
        throw new Error("thread not found");
      },
      () => current,
    );
    await expect(
      tool("codex_session_read").execute("read", { thread_id: THREAD_ID }),
    ).rejects.toThrow("Codex supervision is disabled");
    expect(calls.map((call) => call.endpointId)).toEqual(["first"]);
  });
});
