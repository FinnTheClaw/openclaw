import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { startGatewayServer } from "../gateway/server.js";
import { testing as cliBackendsTesting } from "./cli-backends.js";
import {
  awaitChildDispatchProtocolCommand,
  emitChildDispatchProtocolEvent,
  requireChildDispatchProtocolPath,
} from "./subagent-child-dispatch-process-protocol.js";
import { installChildDispatchTestHooksForProcess } from "./subagent-child-dispatch-test-hooks.js";
import { installGatewayAcceptanceReceiptSigner } from "./subagent-gateway-acceptance-receipt-runtime.js";

const protocolPath = requireChildDispatchProtocolPath();

function installBarrierHooks(): void {
  installChildDispatchTestHooksForProcess({
    onBarrier: async (context) => {
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
          provider: context.provider,
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
}

async function main(): Promise<void> {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
  installBarrierHooks();
  if (process.env.INSTALL_RECEIPT_SIGNER === "1") {
    installGatewayAcceptanceReceiptSigner({
      signingKey: "isolated-child-dispatch-fixture-key",
      generation: "isolated-child-dispatch-fixture-generation",
    });
  }
  const gateway = await startGatewayServer(0, {
    bind: "loopback",
    host: "127.0.0.1",
    auth: { mode: "token", token: process.env.GATEWAY_TOKEN ?? "" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    sidecarStartup: "defer",
  });
  process.stdout.write(`READY ${JSON.stringify({ port: gateway.port })}\n`);
  const control = createInterface({ input: process.stdin });
  let closing = false;
  control.on("line", (line) => {
    if (closing) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || (value as { op?: unknown }).op !== "close") {
      return;
    }
    closing = true;
    void gateway
      .close({ reason: "isolated-child-dispatch-process" })
      .then(() => {
        process.stdout.write("CLOSED\n");
        control.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
        control.close();
      });
  });
}

await main();
