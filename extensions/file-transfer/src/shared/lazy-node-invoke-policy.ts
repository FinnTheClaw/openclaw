import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { FILE_TRANSFER_NODE_INVOKE_COMMANDS } from "./node-invoke-policy-commands.js";

export function createLazyFileTransferNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  let policyPromise: Promise<OpenClawPluginNodeInvokePolicy> | undefined;

  return {
    commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
    async handle(ctx) {
      let policy: OpenClawPluginNodeInvokePolicy;
      let pending: Promise<OpenClawPluginNodeInvokePolicy> | undefined;
      try {
        pending = policyPromise ??= import("./node-invoke-policy.js").then(
          ({ createFileTransferNodeInvokePolicy }) => createFileTransferNodeInvokePolicy(),
        );
        policy = await pending;
      } catch (error) {
        if (policyPromise === pending) {
          policyPromise = undefined;
        }
        const message = error instanceof Error && error.message ? error.message : String(error);
        return {
          ok: false,
          code: "PLUGIN_POLICY_UNAVAILABLE",
          message: `file-transfer PLUGIN_POLICY_UNAVAILABLE: node.invoke policy unavailable: ${message}`,
          unavailable: true,
        };
      }
      return await policy.handle(ctx);
    },
  };
}
