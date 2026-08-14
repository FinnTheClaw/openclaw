import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  awaitChildDispatchProtocolCommand,
  emitChildDispatchProtocolEvent,
} from "./subagent-child-dispatch-process-protocol.js";
import { installChildDispatchTestHooksForProcess } from "./subagent-child-dispatch-test-hooks.js";
import { cancelSubagentChildIntentAtomically } from "./subagent-child-intent-store-lifecycle.sqlite.js";
import { installGatewayAcceptanceReceiptSigner } from "./subagent-gateway-acceptance-receipt-runtime.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

const protocolPath = process.env.CHILD_DISPATCH_PROTOCOL;
if (!protocolPath) {
  throw new Error("CHILD_DISPATCH_PROTOCOL is required");
}

if (process.env.INSTALL_RECEIPT_SIGNER === "1") {
  installGatewayAcceptanceReceiptSigner({
    signingKey: "isolated-child-dispatch-fixture-key",
    generation: "isolated-child-dispatch-fixture-generation",
  });
}

async function emitControllerEvent(
  point: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await emitChildDispatchProtocolEvent({
    path: protocolPath,
    id: randomUUID(),
    point,
    payload,
  });
}

installChildDispatchTestHooksForProcess({
  onBarrier: async (context) => {
    if (context.childIntentKey) {
      activeChildIdentity = {
        childIntentKey: context.childIntentKey,
        controllerSessionKey: context.controllerSessionKey ?? "agent:main:main",
        operationKey: context.operationKey,
      };
    }
    const id = randomUUID();
    await emitChildDispatchProtocolEvent({
      path: protocolPath,
      id,
      point: context.point,
      payload: {
        acceptanceKey: context.acceptanceKey,
        gatewayRunId: context.gatewayRunId,
        childSessionKey: context.childSessionKey,
        childIntentKey: context.childIntentKey,
        controllerSessionKey: context.controllerSessionKey,
        operationKey: context.operationKey,
      },
    });
    const action = await awaitChildDispatchProtocolCommand({
      path: protocolPath,
      id,
      timeoutMs: 45_000,
    });
    return action === "deny" ? "deny" : "allow";
  },
});

const control = createInterface({ input: process.stdin });
let running = false;
let activeChildIdentity:
  | { childIntentKey: string; controllerSessionKey: string; operationKey?: string }
  | undefined;
control.on("line", (line) => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const command = value as {
    op?: unknown;
    task?: unknown;
    operationKey?: unknown;
    model?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
    governed?: unknown;
    childLifecycleMode?: unknown;
  };
  if (command.op === "cancel" && running && activeChildIdentity) {
    const changed = cancelSubagentChildIntentAtomically(activeChildIdentity);
    void emitControllerEvent("controller.cancel.result", { changed });
    return;
  }
  if (running) {
    return;
  }
  if (command.op !== "spawn") {
    return;
  }
  running = true;
  void (async () => {
    await emitControllerEvent("controller.spawn.started");
    try {
      const result = await spawnSubagentDirect(
        {
          task: typeof command.task === "string" ? command.task : "process child probe",
          ...(typeof command.agentId === "string" ? { agentId: command.agentId } : {}),
          model: typeof command.model === "string" ? command.model : undefined,
          mode: "run",
          subagentRole: "leaf",
          idempotencyKey:
            typeof command.operationKey === "string" ? command.operationKey : randomUUID(),
          expectsCompletionMessage: false,
          ...(command.governed === true || command.childLifecycleMode === "governed"
            ? { childLifecycleMode: "governed" as const }
            : {}),
        },
        {
          agentSessionKey:
            typeof command.sessionKey === "string"
              ? command.sessionKey
              : (process.env.CHILD_DISPATCH_AGENT_SESSION_KEY ?? "agent:main:main"),
          gatewayPortOverride: Number(process.env.CHILD_DISPATCH_GATEWAY_PORT),
        },
      );
      await emitControllerEvent("controller.spawn.result", result as Record<string, unknown>);
      process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    } catch (error: unknown) {
      await emitControllerEvent("controller.spawn.error", { error: String(error) });
      process.stdout.write(`ERROR ${JSON.stringify({ error: String(error) })}\n`);
    } finally {
      control.close();
      process.exit(0);
    }
  })();
});

process.stdout.write("READY {}\n");
