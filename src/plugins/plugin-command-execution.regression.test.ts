import { expect, it, vi } from "vitest";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import { executeRegisteredPluginCommand } from "./plugin-command-execution.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const invalidScopes = [
  { label: "empty", value: "" },
  { label: "undefined", value: undefined },
];

it.each(invalidScopes)("rejects a $label required scope during registration", ({ value }) => {
  const registry = createEmptyPluginRegistry();
  const result = registerPluginCommandInRegistry(registry, "scope-fixture", {
    name: "scoped",
    description: "Requires write scope",
    requiredScopes: [value, "operator.write"] as never,
    handler: () => ({ text: "executed" }),
  });

  expect(result.ok).toBe(false);
  expect(registry.commands).toEqual([]);
});

it.each(invalidScopes)("does not execute through a $label required scope", async ({ value }) => {
  const registry = createEmptyPluginRegistry();
  const handler = vi.fn(() => ({ text: "executed" }));
  const result = await executeRegisteredPluginCommand(registry, {
    command: {
      pluginId: "scope-fixture",
      name: "scoped",
      description: "Requires write scope",
      requiredScopes: [value, "operator.write"] as never,
      handler,
    },
    channel: "webchat",
    isAuthorizedSender: true,
    senderIsOwner: false,
    gatewayClientScopes: [],
    commandBody: "/scoped",
    config: {},
  });

  expect(handler).not.toHaveBeenCalled();
  expect(result).toEqual({ text: "⚠️ This command has invalid gateway scope configuration." });
});

it.each([null, undefined])(
  "returns the failure reply when a command rejects with %s",
  async (error) => {
    const registry = createEmptyPluginRegistry();
    await expect(
      executeRegisteredPluginCommand(registry, {
        command: {
          pluginId: "rejection-fixture",
          name: "rejecting",
          description: "Rejects without an Error object",
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise intentional null/undefined plugin rejection values.
          handler: () => Promise.reject(error),
        },
        channel: "webchat",
        isAuthorizedSender: true,
        commandBody: "/rejecting",
        config: {},
      }),
    ).resolves.toEqual({ text: "⚠️ Command failed. Please try again later." });
  },
);
