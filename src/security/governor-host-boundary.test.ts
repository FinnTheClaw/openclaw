import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const authorityModules = [
  "governor-agent-loop-config",
  "governor-agent-loop-contract",
  "governor-agent-loop-host",
  "governor-agent-loop-progress",
  "governor-agent-loop-task",
  "governor-agent-loop-tools",
  "governor-agent-loop-types",
  "governor-agent-loop-values",
  "governor-host-anti-rollback-ledger",
  "governor-host-ledger-codec",
  "governor-host-ledger-storage",
  "governor-host-bootstrap",
  "governor-host-broker",
  "governor-host-canary-sink",
  "governor-host-channel-delivery",
  "governor-host-delivery-build-manifest",
  "governor-host-delivery-build-manifest.generated",
  "governor-host-delivery-broker",
  "governor-host-delivery-implementations",
  "governor-host-delivery-persistence",
  "governor-host-file-lock",
  "governor-host-memory-authority",
  "governor-host-owner-ingress",
  "governor-host-owner-ingress-persistence",
  "governor-host-persistence",
  "governor-host-physical-execution",
  "governor-host-secrets",
  "governor-host-task-authority",
] as const;
const authorityImport = new RegExp(
  `security/(?:${authorityModules.map((name) => name.replaceAll(".", "\\.")).join("|")})(?:\\.js)?["']`,
  "u",
);
const forbiddenAuthority =
  /\b(?:createCompiledOwnerIngress|createGovernorAgentLoopTool|createGovernorHostDeliveryRuntime|createGovernorHostPersistence|createGovernorHostRuntimeBindings|createGovernorHostRuntimeIfEnabled|createHostDeliveryImplementation|createHostGovernorBroker|GovernorHostPersistence|GovernorHostRuntime|GovernorSecrets|HostGovernorCapabilities|installGovernorAgentLoopHost|matchesHostGovernorAgentLoopTool|registerStaticDeliveryAdapter|resolveGovernorSecrets|revokeDeliveryAdapter|revokeOwnerIngressReceipt|signApprovalGrant|submitAuthenticatedOwnerIngress)\b/u;

const allowedAuthorityImporters: Record<(typeof authorityModules)[number], readonly string[]> = {
  "governor-agent-loop-config": [
    "gateway/behavior-governor-lifecycle.ts",
    "security/governor-agent-loop-completed-replay.ts",
    "security/governor-agent-loop-contract.ts",
    "security/governor-agent-loop-progress.ts",
    "security/governor-agent-loop-replay-lookup.ts",
    "security/governor-agent-loop-types.ts",
    "security/governor-agent-loop-host.ts",
    "security/governor-agent-loop-ingress.ts",
    "security/governor-agent-loop-tool-bindings.ts",
    "security/governor-agent-loop-turn-handler.ts",
    "security/governor-host-bootstrap.ts",
  ],
  "governor-agent-loop-contract": ["security/governor-agent-loop-ingress.ts"],
  "governor-agent-loop-host": ["security/governor-host-bootstrap.ts"],
  "governor-agent-loop-progress": [
    "security/governor-agent-loop-host.ts",
    "security/governor-agent-loop-turn-handler.ts",
  ],
  "governor-agent-loop-task": ["security/governor-agent-loop-host.ts"],
  "governor-agent-loop-tools": [
    "security/governor-agent-loop-config.ts",
    "security/governor-agent-loop-host.ts",
    "security/governor-agent-loop-tool-bindings.ts",
  ],
  "governor-agent-loop-types": [
    "security/governor-agent-loop-completed-replay.ts",
    "security/governor-agent-loop-host-close.ts",
    "security/governor-agent-loop-host.ts",
    "security/governor-agent-loop-inert-registry.ts",
    "security/governor-agent-loop-ingress.ts",
    "security/governor-agent-loop-readonly.ts",
    "security/governor-agent-loop-replay-lookup.ts",
    "security/governor-agent-loop-scope-token.ts",
    "security/governor-agent-loop-terminal-replay.ts",
    "security/governor-agent-loop-turn-handler.ts",
  ],
  "governor-agent-loop-values": [
    "security/governor-agent-loop-host.ts",
    "security/governor-agent-loop-task.ts",
  ],
  "governor-host-anti-rollback-ledger": [
    "security/governor-host-delivery-persistence.ts",
    "security/governor-host-memory-authority.ts",
    "security/governor-host-owner-ingress-persistence.ts",
    "security/governor-host-persistence.ts",
    "security/governor-host-physical-execution.ts",
    "security/governor-host-task-authority.ts",
  ],
  "governor-host-ledger-codec": [
    "security/governor-host-anti-rollback-ledger.ts",
    "security/governor-host-ledger-storage.ts",
  ],
  "governor-host-ledger-storage": ["security/governor-host-anti-rollback-ledger.ts"],
  "governor-host-bootstrap": ["gateway/behavior-governor-lifecycle.ts"],
  "governor-host-broker": [
    "security/governor-host-bootstrap.ts",
    "security/governor-host-readonly.ts",
  ],
  "governor-host-canary-sink": ["security/governor-host-delivery-implementations.ts"],
  "governor-host-channel-delivery": [
    "security/governor-host-bootstrap.ts",
    "security/governor-host-broker.ts",
    "security/governor-host-canary-sink.ts",
    "security/governor-host-delivery-broker.ts",
    "security/governor-host-delivery-implementations.ts",
  ],
  "governor-host-delivery-build-manifest": ["security/governor-host-delivery-implementations.ts"],
  "governor-host-delivery-build-manifest.generated": [
    "security/governor-host-delivery-build-manifest.ts",
  ],
  "governor-host-delivery-broker": ["security/governor-host-broker.ts"],
  "governor-host-delivery-implementations": ["security/governor-host-delivery-broker.ts"],
  "governor-host-delivery-persistence": ["security/governor-host-persistence.ts"],
  "governor-host-file-lock": ["security/governor-host-ledger-storage.ts"],
  "governor-host-memory-authority": [
    "security/governor-host-broker.ts",
    "security/governor-host-persistence.ts",
    "security/governor-host-readonly.ts",
  ],
  "governor-host-owner-ingress": ["security/governor-host-bootstrap.ts"],
  "governor-host-owner-ingress-persistence": ["security/governor-host-persistence.ts"],
  "governor-host-persistence": [
    "security/governor-host-bootstrap.ts",
    "security/governor-host-broker-resolvers.ts",
    "security/governor-host-broker.ts",
    "security/governor-host-delivery-broker.ts",
    "security/governor-host-owner-ingress-resolver.ts",
    "security/governor-host-readonly.ts",
  ],
  "governor-host-physical-execution": [
    "security/governor-host-broker.ts",
    "security/governor-host-persistence.ts",
    "security/governor-host-readonly.ts",
  ],
  "governor-host-secrets": [
    "security/governor-host-bootstrap.ts",
    "security/governor-host-broker-resolvers.ts",
    "security/governor-host-broker.ts",
    "security/governor-host-delivery-broker.ts",
    "security/governor-host-owner-ingress-resolver.ts",
    "security/governor-host-persistence.ts",
    "security/governor-host-readonly.ts",
  ],
  "governor-host-task-authority": [
    "security/governor-host-broker.ts",
    "security/governor-host-persistence.ts",
    "security/governor-host-readonly.ts",
  ],
};

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(target)
      : target.endsWith(".ts") && !target.endsWith(".test.ts")
        ? [target]
        : [];
  });
}

describe("governor host authority boundary", () => {
  it("keeps the capability kernel out of task, model, and plugin modules", () => {
    const guarded = ["tasks", "agents", "plugins", "extensions"].flatMap((name) => {
      const target = path.join(root, name);
      return fs.existsSync(target) ? files(target) : [];
    });
    for (const file of guarded) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(authorityImport);
      expect(source, file).not.toMatch(forbiddenAuthority);
    }
  });

  it("keeps host authority and test-only bridge out of package exports", () => {
    const manifest = fs.readFileSync(path.join(root, "..", "package.json"), "utf8");
    for (const moduleName of authorityModules) {
      expect(manifest).not.toContain(moduleName);
    }
    expect(manifest).not.toContain("governor-host-readonly");
  });

  it("allows authority modules only through the explicit whole-source dependency map", () => {
    const productionFiles = files(root);
    for (const moduleName of authorityModules) {
      const importers = productionFiles
        .filter((file) => fs.readFileSync(file, "utf8").includes(`/${moduleName}.js`))
        .map((file) => path.relative(root, file).replaceAll("\\", "/"))
        .toSorted();
      expect(importers, moduleName).toEqual([...allowedAuthorityImporters[moduleName]].toSorted());
    }
  });

  it("keeps ambient process secrets out of the broker, persistence, and governor stores", () => {
    const ambientFree = [
      "security/governor-agent-loop-config.ts",
      "security/governor-agent-loop-host.ts",
      "security/governor-agent-loop-task.ts",
      "security/governor-agent-loop-tools.ts",
      "security/governor-agent-loop-values.ts",
      "security/governor-host-broker.ts",
      "security/governor-host-anti-rollback-ledger.ts",
      "security/governor-host-ledger-codec.ts",
      "security/governor-host-ledger-storage.ts",
      "security/governor-host-delivery-build-manifest.ts",
      "security/governor-host-delivery-broker.ts",
      "security/governor-host-delivery-implementations.ts",
      "security/governor-host-delivery-persistence.ts",
      "security/governor-host-memory-authority.ts",
      "security/governor-host-owner-ingress-persistence.ts",
      "security/governor-host-persistence.ts",
      "security/governor-host-physical-execution.ts",
      "security/governor-host-secrets.ts",
      "security/governor-host-task-authority.ts",
      "tasks/governor/action-intent-store.ts",
      "tasks/governor/approval-store.ts",
      "tasks/governor/checkpoint-store.ts",
      "tasks/governor/controller-bootstrap.ts",
      "tasks/governor/delivery-certification-store.ts",
      "tasks/governor/fanin-reducer-store.ts",
      "tasks/governor/fanout.ts",
      "tasks/governor/memory-integrity.ts",
      "tasks/governor/outbox-store.ts",
      "tasks/governor/store-bootstrap.ts",
      "tasks/governor/store-evidence-admission.ts",
      "tasks/governor/store.ts",
      "tasks/governor/types.ts",
    ];
    for (const relative of ambientFree) {
      expect(fs.readFileSync(path.join(root, relative), "utf8"), relative).not.toContain(
        "process.env",
      );
    }
  });

  it("keeps caller-authoritative verified memory objects out of task-facing stores", () => {
    const guarded = [
      "tasks/governor/memory-integrity.ts",
      "tasks/governor/memory-contradiction-store.ts",
      "tasks/governor/store-evidence-admission.ts",
    ];
    for (const relative of guarded) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toContain("storeVerifiedEvidence");
      expect(source, relative).not.toContain("GovernorVerifiedEvidence");
      expect(source, relative).not.toContain("verifyForUse");
    }
  });

  it("keeps compiled delivery factories free of runtime code injection", () => {
    const filesToCheck = [
      "security/governor-host-canary-sink.ts",
      "security/governor-host-channel-delivery.ts",
      "security/governor-host-delivery-broker.ts",
      "security/governor-host-delivery-implementations.ts",
      "security/governor-host-owner-ingress.ts",
    ];
    const executableLoader =
      /\b(?:eval|Function|child_process|spawn|execFile|execSync|import)\s*\(/u;
    for (const relative of filesToCheck) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(executableLoader);
    }
  });
});
