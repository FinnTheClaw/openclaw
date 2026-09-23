import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.js";

const URL = "https://packages.acme.example/openclaw/feed";
const PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

function signedEnvelope(feed: object, keyId: string): string {
  const payload = Buffer.from(JSON.stringify(feed), "utf8");
  const type = Buffer.from(PAYLOAD_TYPE, "utf8");
  const signingInput = Buffer.concat([
    Buffer.from("DSSEv1 " + type.length + " " + PAYLOAD_TYPE + " " + payload.length + " ", "utf8"),
    payload,
  ]);
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return JSON.stringify({
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString("base64url"),
    signatures: [
      { keyid: keyId, sig: crypto.sign(null, signingInput, privateKey).toString("base64url") },
    ],
  });
}

function snapshot(body: string): HostedOfficialExternalPluginCatalogSnapshot {
  return {
    body,
    metadata: {
      url: URL,
      status: 200,
      checksum: "sha256:" + crypto.createHash("sha256").update(body).digest("hex"),
    },
    savedAt: "2026-06-22T00:00:10.000Z",
    trust: {
      mode: "signed",
      signedBy: "acme-root",
      signatureCount: 1,
      threshold: 1,
      verifiedAt: "2026-06-22T00:00:10.000Z",
    },
    monotonic: { mode: "signed-feed", sequence: 10 },
  };
}

describe("L7-02 signed snapshot with unavailable stored generatedAt", () => {
  it.each([
    { name: "missing timestamp rejects changed payload", generatedAt: undefined, changed: true },
    { name: "missing timestamp allows identical re-sign", generatedAt: undefined, changed: false },
    { name: "null timestamp rejects changed payload", generatedAt: null, changed: true },
    { name: "null timestamp allows identical re-sign", generatedAt: null, changed: false },
    { name: "numeric timestamp rejects changed payload", generatedAt: 123, changed: true },
    { name: "numeric timestamp allows identical re-sign", generatedAt: 123, changed: false },
    { name: "text timestamp rejects changed payload", generatedAt: "not-a-date", changed: true },
    { name: "text timestamp allows identical re-sign", generatedAt: "not-a-date", changed: false },
    {
      name: "impossible date rejects changed payload",
      generatedAt: "2026-02-30T00:00:00.000Z",
      changed: true,
    },
    {
      name: "impossible date allows identical re-sign",
      generatedAt: "2026-02-30T00:00:00.000Z",
      changed: false,
    },
  ] as const)("$name", async ({ generatedAt, changed }) => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-l7-02-"));
    const store = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({ stateDir });
    const feed = {
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
      sequence: 10,
      entries: [],
    };
    const original = signedEnvelope(feed, "acme-root");
    const candidate = signedEnvelope(
      changed ? { ...feed, entries: [{ name: "@openclaw/changed" }] } : feed,
      "acme-rotated",
    );
    try {
      await store.write(snapshot(original));
      if (changed) {
        await expect(store.write(snapshot(candidate))).rejects.toThrow(
          "payload changed without a sequence increment",
        );
      } else {
        expect(candidate).not.toBe(original);
        await expect(store.write(snapshot(candidate))).resolves.toBeUndefined();
      }
      await expect(store.read(URL)).resolves.toMatchObject({
        body: changed ? original : candidate,
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
