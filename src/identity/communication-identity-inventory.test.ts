import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  sanitizeCommunicationIdentityInventory,
  sanitizeCommunicationSessionOrigin,
} from "./communication-identity-inventory.js";
import type { CommunicationIdentityRegistry } from "./communication-identity-registry.js";

const SECRET_CANARY = "fake-hmac-secret-canary-never-expose";

function fakeRegistry(): CommunicationIdentityRegistry {
  return {
    version: 1,
    hmacKey: SECRET_CANARY,
    adminIdentityId: "id-aaaaaaaaaaaaaaaaaaaaaaaa",
    updatedAt: "2026-08-09T12:00:00.000Z",
    identities: {
      "id-aaaaaaaaaaaaaaaaaaaaaaaa": {
        id: "id-aaaaaaaaaaaaaaaaaaaaaaaa",
        canonicalKind: "phone",
        phone: "+15125559113",
        memberAgentId: "person-aaaaaaaaaaaaaaaa",
        workspace: "/fake/admin-workspace",
        agentDir: "/fake/admin-agent",
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T12:00:00.000Z",
        endpoints: [
          {
            channel: "signal",
            accountId: "primary",
            peerKind: "direct",
            peerId: "fake-signal-uuid-9113",
            linkedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
      },
      "id-bbbbbbbbbbbbbbbbbbbbbbbb": {
        id: "id-bbbbbbbbbbbbbbbbbbbbbbbb",
        canonicalKind: "channel-peer",
        memberAgentId: "person-bbbbbbbbbbbbbbbb",
        workspace: "/fake/member-workspace",
        agentDir: "/fake/member-agent",
        createdAt: "2026-08-09T11:00:00.000Z",
        updatedAt: "2026-08-09T11:30:00.000Z",
        endpoints: [
          {
            channel: "matrix",
            accountId: "primary",
            peerKind: "direct",
            peerId: "fake-matrix-peer-7255",
            linkedAt: "2026-08-09T11:00:00.000Z",
          },
        ],
      },
    },
  };
}

describe("communication identity inventory", () => {
  it("projects only bounded redacted access evidence", () => {
    const registry = fakeRegistry();
    const inventory = sanitizeCommunicationIdentityInventory(registry);
    const serialized = JSON.stringify(inventory);

    expect(inventory.entries).toHaveLength(2);
    expect(inventory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointType: "signal",
          redactedIdentifier: "***9113",
          routingState: "admin",
          authState: "authorized",
          label: "Administrator",
        }),
        expect.objectContaining({
          endpointType: "matrix",
          redactedIdentifier: "***7255",
          routingState: "isolated",
          label: "Isolated member",
        }),
      ]),
    );
    for (const forbidden of [
      SECRET_CANARY,
      "+15125559113",
      "fake-signal-uuid-9113",
      "fake-matrix-peer-7255",
      "/fake/admin-workspace",
      "/fake/member-agent",
      "id-aaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("resolves a session origin without exposing raw route metadata", () => {
    const entry: SessionEntry = {
      sessionId: "fake-session",
      updatedAt: Date.parse("2026-08-09T12:30:00.000Z"),
      origin: {
        provider: "signal",
        accountId: "primary",
        nativeDirectUserId: "fake-signal-uuid-9113",
        from: "+15125559113",
        threadId: "fake-thread-secret",
      },
      lastTo: "fake-raw-destination",
    };
    const origin = sanitizeCommunicationSessionOrigin({
      registry: fakeRegistry(),
      entry,
      sessionKey: "agent:finn:signal:direct:fake-signal-uuid-9113",
    });
    const serialized = JSON.stringify(origin);

    expect(origin).toMatchObject({
      endpointType: "signal",
      redactedIdentifier: "***9113",
      boundState: "bound",
      routingState: "admin",
      authState: "authorized",
    });
    for (const forbidden of [
      SECRET_CANARY,
      "+15125559113",
      "fake-signal-uuid-9113",
      "fake-thread-secret",
      "fake-raw-destination",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("resolves canonical accountful session keys without origin metadata", () => {
    const entry: SessionEntry = {
      sessionId: "fake-accountful-session",
      updatedAt: Date.parse("2026-08-09T12:35:00.000Z"),
    };
    const origin = sanitizeCommunicationSessionOrigin({
      registry: fakeRegistry(),
      entry,
      sessionKey: "agent:finn:signal:primary:direct:fake-signal-uuid-9113",
    });

    expect(origin).toMatchObject({
      endpointType: "signal",
      redactedIdentifier: "***9113",
      boundState: "bound",
      routingState: "admin",
      authState: "authorized",
    });
    expect(JSON.stringify(origin)).not.toContain("fake-signal-uuid-9113");
  });

  it("reports an unknown quarantine origin without treating it as authorized", () => {
    const entry: SessionEntry = {
      sessionId: "fake-quarantine-session",
      updatedAt: Date.parse("2026-08-09T13:00:00.000Z"),
      origin: { provider: "signal", nativeDirectUserId: "unknown-peer-7255" },
    };
    const origin = sanitizeCommunicationSessionOrigin({
      registry: fakeRegistry(),
      entry,
      sessionKey: "agent:communication-quarantine:signal:direct:unknown-peer-7255",
    });

    expect(origin).toMatchObject({
      endpointType: "signal",
      redactedIdentifier: "***7255",
      boundState: "unbound",
      routingState: "quarantine",
      authState: "pending",
      label: "Pairing quarantine",
    });
  });
});
