import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/config/sessions.js";
import {
  sanitizeCommunicationIdentityInventory,
  sanitizeCommunicationSessionOrigin,
} from "../../src/identity/communication-identity-inventory.js";
import type { CommunicationIdentityRegistry } from "../../src/identity/communication-identity-registry.js";
import { redactSensitiveText } from "../../src/logging/redact.js";
import {
  registerSecretValueForRedaction,
  resetSecretRedactionRegistryForTest,
} from "../../src/logging/secret-redaction-registry.js";
import { EvidenceRecoveryTracker } from "../active-memory/evidence-recovery.js";
import { HybridMemoryIndex } from "./hybrid-memory-index.js";
import { resolveTrustedMemoryScope } from "./memory-scope.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

const FAKE_HMAC_CANARY = "fake-p0-hmac-canary-never-expose-9113";

function registry(): CommunicationIdentityRegistry {
  return {
    version: 1,
    hmacKey: FAKE_HMAC_CANARY,
    adminIdentityId: "id-admin-opaque",
    updatedAt: "2026-08-09T22:25:00.000Z",
    identities: {
      "id-admin-opaque": {
        id: "id-admin-opaque",
        canonicalKind: "phone",
        phone: "+15125559113",
        memberAgentId: "finn",
        workspace: "/fake/admin-workspace",
        agentDir: "/fake/admin-agent",
        createdAt: "2026-08-09T22:00:00.000Z",
        updatedAt: "2026-08-09T22:25:00.000Z",
        endpoints: [
          {
            channel: "signal",
            accountId: "primary",
            peerKind: "direct",
            peerId: "fake-signal-peer-9113",
            linkedAt: "2026-08-09T22:00:00.000Z",
          },
        ],
      },
      "id-member-opaque": {
        id: "id-member-opaque",
        canonicalKind: "phone",
        phone: "+15125557255",
        memberAgentId: "person-member-opaque",
        workspace: "/fake/member-workspace",
        agentDir: "/fake/member-agent",
        createdAt: "2026-08-09T22:05:00.000Z",
        updatedAt: "2026-08-09T22:20:00.000Z",
        endpoints: [
          {
            channel: "signal",
            accountId: "primary",
            peerKind: "direct",
            peerId: "fake-signal-peer-7255",
            linkedAt: "2026-08-09T22:05:00.000Z",
          },
        ],
      },
    },
  };
}

describe("P0 redacted identity-memory replay contract", () => {
  let tmpDir = "";

  beforeEach(async () => {
    resetSecretRedactionRegistryForTest();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p0-identity-memory-replay-"));
  });

  afterEach(async () => {
    resetSecretRedactionRegistryForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finishes the corrected four-message task without cross-principal or secret leakage", async () => {
    const fourMessageReplay = [
      { sender: "***9113", text: "List the currently authorized contacts and their labels." },
      { sender: "***9113", text: "Correction: current structured access state outranks history." },
      {
        sender: "***9113",
        text: "Forget the stale access claim and verify deletion semantically.",
      },
      { sender: "***9113", text: "Finalize only after every typed postcondition is satisfied." },
    ];
    expect(fourMessageReplay).toHaveLength(4);

    const currentRegistry = registry();
    registerSecretValueForRedaction(currentRegistry.hmacKey);
    const inventory = sanitizeCommunicationIdentityInventory(currentRegistry);
    const adminEntry: SessionEntry = {
      sessionId: "session-admin-opaque",
      updatedAt: Date.parse("2026-08-09T22:25:00.000Z"),
      origin: {
        label: "Primary owner",
        provider: "signal",
        accountId: "primary",
        nativeDirectUserId: "fake-signal-peer-9113",
      },
    };
    const memberEntry: SessionEntry = {
      sessionId: "session-member-opaque",
      updatedAt: Date.parse("2026-08-09T22:20:00.000Z"),
      origin: {
        label: "Family member",
        provider: "signal",
        accountId: "primary",
        nativeDirectUserId: "fake-signal-peer-7255",
      },
    };
    const adminOrigin = sanitizeCommunicationSessionOrigin({
      registry: currentRegistry,
      entry: adminEntry,
      sessionKey: "agent:finn:signal:primary:direct:fake-signal-peer-9113",
    });
    const memberOrigin = sanitizeCommunicationSessionOrigin({
      registry: currentRegistry,
      entry: memberEntry,
      sessionKey: "agent:person-member-opaque:signal:primary:direct:fake-signal-peer-7255",
    });
    expect(adminOrigin).toMatchObject({
      redactedIdentifier: "***9113",
      label: "Primary owner",
      routingState: "admin",
    });
    expect(memberOrigin).toMatchObject({
      redactedIdentifier: "***7255",
      label: "Family member",
      routingState: "isolated",
    });
    const projected = JSON.stringify({ inventory, adminOrigin, memberOrigin });
    for (const forbidden of [
      FAKE_HMAC_CANARY,
      "+15125559113",
      "+15125557255",
      "fake-signal-peer-9113",
      "fake-signal-peer-7255",
      "/fake/admin-workspace",
      "/fake/member-workspace",
    ]) {
      expect(projected).not.toContain(forbidden);
    }
    expect(redactSensitiveText(`logger ${FAKE_HMAC_CANARY}`, { mode: "off" })).not.toContain(
      FAKE_HMAC_CANARY,
    );

    const adminScope = resolveTrustedMemoryScope({
      agentId: "finn",
      workspaceDir: path.join(tmpDir, "admin-workspace"),
      sessionKey: "agent:finn:signal:primary:direct:fake-signal-peer-9113",
      channel: "signal",
      accountId: "primary",
      conversationId: "fake-signal-peer-9113",
    });
    const adminWhatsAppScope = resolveTrustedMemoryScope({
      agentId: "finn",
      workspaceDir: path.join(tmpDir, "admin-workspace"),
      sessionKey: "agent:finn:whatsapp:primary:direct:fake-whatsapp-peer-9113",
      channel: "whatsapp",
      accountId: "primary",
      conversationId: "fake-whatsapp-peer-9113",
    });
    const memberScope = resolveTrustedMemoryScope({
      agentId: "person-member-opaque",
      workspaceDir: path.join(tmpDir, "member-workspace"),
      sessionKey: "agent:person-member-opaque:signal:primary:direct:fake-signal-peer-7255",
      channel: "signal",
      accountId: "primary",
      conversationId: "fake-signal-peer-7255",
    });
    expect(adminWhatsAppScope.storageAgentId).toBe(adminScope.storageAgentId);
    expect(adminWhatsAppScope.conversationScope).not.toBe(adminScope.conversationScope);
    expect(memberScope.storageAgentId).not.toBe(adminScope.storageAgentId);

    const indexPath = path.join(tmpDir, "index");
    const vector = [1, 0, 0, 0];
    const firstIndex = new HybridMemoryIndex(indexPath, vector.length);
    await firstIndex.upsertBatch([
      {
        id: "admin-event",
        recordType: "event",
        text: "The owner-only replay marker is heliotrope-admin.",
        vector,
        agentId: adminScope.storageAgentId,
        scope: adminScope.conversationScope,
      },
      {
        id: "member-event",
        recordType: "event",
        text: "The member-only replay marker is heliotrope-member.",
        vector,
        agentId: memberScope.storageAgentId,
        scope: memberScope.conversationScope,
      },
    ]);
    expect(
      (
        await firstIndex.search({
          queryText: "heliotrope-member",
          vector,
          agentId: adminScope.storageAgentId,
          scope: adminScope.conversationScope,
          limit: 10,
        })
      ).map((result) => result.entry.id),
    ).toEqual(["admin-event"]);
    firstIndex.close();
    const reopenedIndex = new HybridMemoryIndex(indexPath, vector.length);
    expect(
      (
        await reopenedIndex.search({
          queryText: "heliotrope",
          vector,
          agentId: memberScope.storageAgentId,
          scope: memberScope.conversationScope,
          limit: 10,
        })
      ).map((result) => result.entry.id),
    ).toEqual(["member-event"]);
    reopenedIndex.close();

    const ledger = new TemporalMemoryLedger(path.join(tmpDir, "ledger.sqlite3"));
    try {
      const stale = ledger.appendEvent({
        agentId: adminScope.storageAgentId,
        sessionKey: adminScope.sessionRef,
        channel: adminScope.channel,
        conversationId: adminScope.conversationRef,
        role: "assistant",
        content: "The stale assistant claim says 7255 is an administrator.",
        sourceKind: "manual_memory",
        metadata: {
          evidenceClass: "assistant_claim",
          verificationStatus: "candidate",
          retrievalStatus: "candidate",
          memoryScope: adminScope.conversationScope,
        },
      }).event;
      const failedOperation = ledger.beginOperation({
        kind: "forget",
        agentId: adminScope.storageAgentId,
        targetRef: stale.eventId,
      });
      ledger.completeOperation({
        operationId: failedOperation,
        state: "failed",
        outcome: "partial_failure",
        evidence: { exactAbsent: true, semanticAbsent: false },
      });
      expect(ledger.getOperationReceipt(failedOperation)).toMatchObject({
        state: "failed",
        outcome: "partial_failure",
        evidence: { exactAbsent: true, semanticAbsent: false },
      });

      const firstAttempt = new EvidenceRecoveryTracker(4);
      firstAttempt.observe({
        toolName: "communication_access",
        result: inventory,
        isError: false,
        hasUsableEvidence: true,
        isUnavailable: false,
      });
      firstAttempt.observe({
        toolName: "session_status",
        result: memberOrigin,
        isError: false,
        hasUsableEvidence: true,
        isUnavailable: false,
      });
      firstAttempt.observe({
        toolName: "memory_forget",
        result: ledger.getOperationReceipt(failedOperation),
        isError: false,
        hasUsableEvidence: true,
        isUnavailable: false,
      });
      expect(
        firstAttempt.finalize({
          hasUsableEvidence: true,
          hasFinalSummary: false,
          noReply: true,
          semanticFailures: ["Forget remained partial: semanticAbsent=false."],
        }),
      ).toMatchObject({ terminationReason: "failed", callsUsed: 3 });

      expect(ledger.deleteEventForAgent(stale.eventId, adminScope.storageAgentId)).toBe(true);
      const successfulOperation = ledger.beginOperation({
        kind: "forget",
        agentId: adminScope.storageAgentId,
        targetRef: stale.eventId,
      });
      ledger.completeOperation({
        operationId: successfulOperation,
        state: "completed",
        outcome: "deleted",
        evidence: { exactAbsent: true, semanticAbsent: true },
      });
      const recoveryCalls = [
        { toolName: "communication_access", result: inventory },
        { toolName: "session_status", result: adminOrigin },
        { toolName: "session_status", result: memberOrigin },
        { toolName: "memory_forget", result: ledger.getOperationReceipt(successfulOperation) },
      ];
      const recovery = new EvidenceRecoveryTracker(4);
      for (const call of recoveryCalls) {
        recovery.observe({
          ...call,
          isError: false,
          hasUsableEvidence: true,
          isUnavailable: false,
        });
      }
      expect(
        recovery.finalize({
          hasUsableEvidence: true,
          hasFinalSummary: true,
          noReply: false,
        }),
      ).toMatchObject({ terminationReason: "completed", callsUsed: 4 });
      expect(recoveryCalls.map((call) => call.toolName)).toEqual([
        "communication_access",
        "session_status",
        "session_status",
        "memory_forget",
      ]);
    } finally {
      ledger.close();
    }
  });
});
