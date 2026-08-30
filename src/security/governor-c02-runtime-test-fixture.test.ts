import crypto from "node:crypto";
import { expect, it } from "vitest";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { normalizeToolParameters } from "../agents/agent-tools.schema.js";
import { canonicalGovernorJson } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { GOVERNOR_C02_HOST_REGISTRATION } from "./governor-c02-runtime-attestation.js";
import type { GovernorHostRuntime } from "./governor-host-bootstrap.js";

const HOSTS = new WeakMap<
  GovernorHostRuntime,
  ReturnType<typeof GOVERNOR_C02_HOST_REGISTRATION.bind>
>();

export function governorC02TestEnvironment(
  systemdInvocationId = "c02-systemd-a",
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c02-identity-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c02-evidence-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c02-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c02-receipt-key-long",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c02-ledger-key-long",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c02-deployment-long",
    INVOCATION_ID: systemdInvocationId,
  };
}

export function bindGovernorC02TestHost(
  host: GovernorHostRuntime,
  capabilities: readonly GovernorCapabilityDefinition[],
  systemdInvocationId: string,
): void {
  HOSTS.set(
    host,
    GOVERNOR_C02_HOST_REGISTRATION.bind({
      controller: host.adapter.controller,
      store: host.adapter.controller.store,
      capabilities,
      systemdInvocationId,
      seal: (value) =>
        crypto
          .createHmac("sha256", "c02-receipt-key-long")
          .update(canonicalGovernorJson(value))
          .digest("hex"),
    }),
  );
}

export function governorC02TestHostRegistration(host: GovernorHostRuntime) {
  const registration = HOSTS.get(host);
  if (!registration) {
    throw new Error("C02 host registration unavailable");
  }
  return registration;
}

export function normalizedC02GatewayRegistry(): readonly AgentTool[] {
  const tool = (name: "read" | "exec", argument: "path" | "command"): AgentTool =>
    normalizeToolParameters({
      name,
      label: name,
      description: `Gateway-installed ${name}`,
      parameters: {
        type: "object",
        properties: { [argument]: { type: "string" } },
        required: [argument],
        additionalProperties: false,
      },
      execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: null }),
    });
  return Object.freeze([tool("read", "path"), tool("exec", "command")]);
}

it("provides the exact normalized gateway read and exec fixture", () => {
  expect(normalizedC02GatewayRegistry().map((tool) => tool.name)).toEqual(["read", "exec"]);
});
