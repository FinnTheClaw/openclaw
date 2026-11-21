import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMocks = vi.hoisted(() => ({ sendTypingSignal: vi.fn(), sendMessageSignal: vi.fn() }));
// mock-isolation: Native approval delivery is observed through synthetic transport calls only.
vi.mock("./send.js", () => sendMocks);
const { transport } = (await import("./approval-handler.runtime.js")).signalApprovalNativeRuntime;
const to = "+15551230000";
const context = { baseUrl: "http://127.0.0.1:18080", account: "+15550001111" };
const manualText =
  "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny";
const reactionHint = "React with:\n\n👍 Allow Once\n👎 Deny";
const reactionText = manualText.replace("Reply with:", `${reactionHint}\n\nReply with:`);
type SignalConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;

function prepare(
  cfg: OpenClawConfig | undefined,
  target: string,
  accountId?: string,
  bound = true,
) {
  return transport.prepareTarget({
    cfg,
    plannedTarget: { target: { to: target } },
    accountId,
    context: bound ? context : { baseUrl: context.baseUrl },
  } as never);
}

function deliver(
  cfg: OpenClawConfig,
  prepared: Awaited<ReturnType<typeof prepare>>,
  text = "approval",
) {
  return transport.deliverPending({
    cfg,
    preparedTarget: prepared!.target,
    pendingPayload: {
      manualFallbackPayload: { text },
      reactionPayload: {
        text: text === manualText ? reactionText : text,
        allowedDecisions: ["allow-once", "deny"],
        reactionBindings: [],
      },
    },
  } as never);
}

describe("Signal approval native runtime", () => {
  beforeEach(() => {
    sendMocks.sendTypingSignal.mockReset().mockResolvedValue(true);
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000000",
      timestamp: 1700000000000,
      receipt: { parts: [] },
    });
  });

  it.each<[SignalConfig, string, string | undefined, string]>([
    [{ allowFrom: [to], aliases: { me: to } }, "me", "default", "default"],
    [
      { defaultAccount: "work", accounts: { work: { aliases: { ops: to } } } },
      "ops",
      undefined,
      "work",
    ],
  ])(
    "resolves aliases for %s before delivering approval prompts",
    async (signal, alias, explicit, accountId) => {
      const cfg = { channels: { signal } };
      const prepared = await prepare(cfg, `signal:${alias}`, explicit);
      const options = { cfg, accountId, ...context };
      expect(prepared?.target).toMatchObject({ to, accountId, ...context });
      expect(await deliver(cfg, prepared)).toMatchObject({ to, conversationKey: to });
      expect(sendMocks.sendTypingSignal).toHaveBeenCalledWith(to, options);
      expect(sendMocks.sendMessageSignal).toHaveBeenCalledWith(to, "approval", {
        ...options,
        textMode: "markdown",
      });
    },
  );

  it("sends system-agent approvals with manual commands even when reactions are configured", async () => {
    const cfg = { channels: { signal: { allowFrom: ["+15551230000"] } } };
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent-approval-123",
      request: {
        title: "Change settings",
        description: "Update the agent settings",
        command: "update",
        proposalHash: "hash",
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "session-1",
      },
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
    };
    const view = {
      approvalKind: "system-agent" as const,
      approvalId: request.id,
      phase: "pending" as const,
      title: "OpenClaw change requires approval",
      operationSummary: request.request.description,
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          command: "/approve system-agent-approval-123 allow-once",
        },
        { decision: "deny", label: "Deny", command: "/approve system-agent-approval-123 deny" },
      ],
      expiresAtMs: request.expiresAtMs,
    };
    const pendingPayload = await signalApprovalNativeRuntime.presentation.buildPendingPayload({
      request,
      view,
      nowMs: 1_000,
    } as never);
    const prepared = await signalApprovalNativeRuntime.transport.prepareTarget({
      plannedTarget: { target: { to: "+15551230000" } },
      accountId: "default",
      context: { account: "+15550001111" },
    } as never);
    const entry = await signalApprovalNativeRuntime.transport.deliverPending({
      cfg,
      preparedTarget: prepared!.target,
      pendingPayload,
    } as never);
    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      "+15551230000",
      expect.stringContaining("/approve system-agent-approval-123"),
      expect.any(Object),
    );
    expect(sendMocks.sendMessageSignal.mock.lastCall?.[1]).not.toContain("React with:");
    expect(entry?.reactionsActive).toBe(false);
    expect(
      await signalApprovalNativeRuntime.interactions.bindPending({
        entry,
        request,
        view,
        pendingPayload,
      } as never),
    ).toBeNull();
  });

  it("only renders reaction hints when the Signal target author can be bound", async () => {
    const cfg = { channels: { signal: { allowFrom: [to] } } };
    await deliver(cfg, await prepare(undefined, to, "default", false), manualText);
    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      to,
      expect.not.stringContaining("React with:"),
      expect.any(Object),
    );
    await deliver(cfg, await prepare(undefined, to, "default"), manualText);
    expect(sendMocks.sendMessageSignal).toHaveBeenLastCalledWith(
      to,
      expect.stringContaining(reactionHint),
      expect.any(Object),
    );
  });
});
