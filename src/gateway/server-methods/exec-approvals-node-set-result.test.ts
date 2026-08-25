import { describe, expect, it, vi } from "vitest";
import { execApprovalsHandlers } from "./exec-approvals.js";

const command = "system.execApprovals.set";
const params = {
  nodeId: "windows-node",
  native: { defaultAction: "deny" as const, rules: [] },
  baseHash: "sha256:current",
};

function makeContext(result: { payload?: unknown; payloadJSON?: string }) {
  return {
    getRuntimeConfig: () => ({}),
    nodeRegistry: {
      get: () => ({
        nodeId: "windows-node",
        connId: "conn-1",
        platform: "windows",
        deviceFamily: "Windows",
        declaredCommands: [command],
        commands: [command],
      }),
      invoke: vi.fn().mockResolvedValue({ ok: true, ...result }),
    },
  } as never;
}

describe("exec approvals node set result boundary", () => {
  it.each([
    ["malformed JSON", { payloadJSON: "{" }],
    ["JSON string", { payloadJSON: JSON.stringify("updated") }],
    ["array", { payload: [] }],
    ["arbitrary object", { payload: { ok: true } }],
    [
      "payloadJSON-shaped object",
      { payload: { payloadJSON: JSON.stringify({ updated: true, hash: "sha256:next" }) } },
    ],
    ["debug field", { payload: { updated: true, hash: "sha256:next", debug: true } }],
    ["token field", { payload: { updated: true, hash: "sha256:next", token: "secret" } }],
    ["raw field", { payload: { updated: true, hash: "sha256:next", raw: "secret" } }],
    [
      "mixed file and native shape",
      {
        payload: {
          path: "/tmp/exec-approvals.json",
          exists: true,
          hash: "sha256:file",
          file: { version: 1 },
          updated: true,
        },
      },
    ],
  ])("rejects %s responses", async (_name, result) => {
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: { type: "req", id: "req-invalid-node-set", method: "exec.approvals.node.set", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: makeContext(result),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node returned invalid exec approvals payload" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("secret");
  });
});
