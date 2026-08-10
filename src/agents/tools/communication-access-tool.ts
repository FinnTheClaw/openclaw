import { Type } from "typebox";
import {
  loadCommunicationIdentityInventory,
  type SanitizedCommunicationInventory,
} from "../../identity/communication-identity-inventory.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const CommunicationAccessToolSchema = Type.Object({});

type CommunicationInventoryLoader = () => Promise<SanitizedCommunicationInventory>;

export function createCommunicationAccessTool(opts?: {
  loadInventory?: CommunicationInventoryLoader;
}): AnyAgentTool {
  return {
    label: "Communication Access",
    name: "communication_access",
    displaySummary: "Inspect sanitized communication access bindings.",
    description:
      "List authorized communication endpoints using redacted identifiers and opaque evidence references. Read-only and owner/local-only.",
    parameters: CommunicationAccessToolSchema,
    execute: async () => {
      try {
        return jsonResult(await (opts?.loadInventory ?? loadCommunicationIdentityInventory)());
      } catch {
        throw new Error("Communication access inventory is unavailable.");
      }
    },
  };
}
