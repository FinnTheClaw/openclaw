// Focused SQLite attachment-delete atomicity and stale-writer regression cases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WorkboardCardStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

type Stores = ReturnType<typeof createWorkboardSqliteStores>;

async function withSqlite(
  run: (store: WorkboardStore, stores: Stores, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-attachment-delete-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const stores = createWorkboardSqliteStores({ dbPath });
  const store = new WorkboardStore(stores.cards, { attachments: stores.attachments });
  try {
    await run(store, stores, dbPath);
  } finally {
    await store.close();
    stores.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function attach(store: WorkboardStore, cardId: string, fileName = "evidence.txt") {
  const updated = await store.addAttachment(cardId, {
    fileName,
    contentBase64: Buffer.from(fileName).toString("base64"),
  });
  const attachment = updated.metadata?.attachments?.find((entry) => entry.fileName === fileName);
  if (!attachment) {
    throw new Error("attachment fixture missing");
  }
  return attachment.id;
}

function countRows(db: DatabaseSync, table: string, attachmentId: string): number {
  const column = table === "workboard_attachment_blobs" ? "attachment_id" : "id";
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM " + table + " WHERE " + column + " = ?")
    .get(attachmentId) as { count: number };
  return row.count;
}

describe("workboard SQLite attachment deletion", () => {
  it("01 removes the card index and blob in one successful deletion", async () => {
    await withSqlite(async (store, _stores, dbPath) => {
      const card = await store.create({ title: "Delete attachment" });
      const attachmentId = await attach(store, card.id);
      const before = await store.get(card.id);
      const deleted = await store.deleteAttachment(card.id, attachmentId);
      const db = new DatabaseSync(dbPath);
      try {
        expect(deleted.updatedAt).toBeGreaterThan(before!.updatedAt);
        expect(deleted.metadata?.attachments ?? []).toHaveLength(0);
        expect(await store.getAttachment(attachmentId)).toBeUndefined();
        expect(countRows(db, "workboard_card_attachments", attachmentId)).toBe(0);
        expect(countRows(db, "workboard_attachment_blobs", attachmentId)).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("02 preserves a sibling attachment and its content", async () => {
    await withSqlite(async (store) => {
      const card = await store.create({ title: "Sibling" });
      const removedId = await attach(store, card.id, "removed.txt");
      const keptId = await attach(store, card.id, "kept.txt");
      const deleted = await store.deleteAttachment(card.id, removedId);
      expect(deleted.metadata?.attachments?.map((entry) => entry.id)).toEqual([keptId]);
      expect(await store.getAttachment(removedId)).toBeUndefined();
      expect(await store.getAttachment(keptId)).toMatchObject({
        contentBase64: Buffer.from("kept.txt").toString("base64"),
      });
    });
  });

  it("03 preserves another card's attachment", async () => {
    await withSqlite(async (store) => {
      const first = await store.create({ title: "First" });
      const second = await store.create({ title: "Second" });
      const removedId = await attach(store, first.id);
      const keptId = await attach(store, second.id, "other.txt");
      await store.deleteAttachment(first.id, removedId);
      expect((await store.get(second.id))?.metadata?.attachments?.[0]?.id).toBe(keptId);
      expect(await store.getAttachment(keptId)).toBeDefined();
    });
  });

  it("04 rejects an unknown card without deleting an existing blob", async () => {
    await withSqlite(async (store) => {
      const card = await store.create({ title: "Existing" });
      const attachmentId = await attach(store, card.id);
      await expect(store.deleteAttachment("missing-card", attachmentId)).rejects.toThrow(
        /card not found/,
      );
      expect(await store.getAttachment(attachmentId)).toBeDefined();
      expect((await store.get(card.id))?.metadata?.attachments?.[0]?.id).toBe(attachmentId);
    });
  });

  it("05 rejects an unknown attachment without changing the card", async () => {
    await withSqlite(async (store) => {
      const card = await store.create({ title: "Existing" });
      const attachmentId = await attach(store, card.id);
      const before = await store.get(card.id);
      await expect(store.deleteAttachment(card.id, "missing-attachment")).rejects.toThrow(
        /attachment not found/,
      );
      expect(await store.get(card.id)).toEqual(before);
      expect(await store.getAttachment(attachmentId)).toBeDefined();
    });
  });

  it("06 rejects a mismatched claim scope without touching metadata or content", async () => {
    await withSqlite(async (store) => {
      const card = await store.create({ title: "Claimed" });
      const attachmentId = await attach(store, card.id);
      await store.claim(card.id, { ownerId: "worker-a", token: "owner-token" });
      const before = await store.get(card.id);
      await expect(
        store.deleteAttachment(card.id, attachmentId, {
          ownerId: "worker-b",
          token: "wrong-token",
        }),
      ).rejects.toThrow(/claimed by worker-a/);
      expect(await store.get(card.id)).toEqual(before);
      expect(await store.getAttachment(attachmentId)).toBeDefined();
    });
  });

  it("07 permits the matching claim scope while retaining claim state", async () => {
    await withSqlite(async (store) => {
      const card = await store.create({ title: "Claimed" });
      const attachmentId = await attach(store, card.id);
      const claim = await store.claim(card.id, { ownerId: "worker-a", token: "owner-token" });
      const deleted = await store.deleteAttachment(card.id, attachmentId, {
        ownerId: "worker-a",
        token: claim.token,
      });
      expect(deleted.metadata?.claim?.ownerId).toBe("worker-a");
      expect(deleted.metadata?.attachments ?? []).toHaveLength(0);
      expect(await store.getAttachment(attachmentId)).toBeUndefined();
    });
  });

  it("08 rolls back the blob when the parent card update fails", async () => {
    await withSqlite(async (store, _stores, dbPath) => {
      const card = await store.create({ title: "Card update failure" });
      const attachmentId = await attach(store, card.id);
      const before = await store.get(card.id);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          "CREATE TRIGGER fail_card_update BEFORE UPDATE ON workboard_cards " +
            "BEGIN SELECT RAISE(ABORT, 'injected card update failure'); END",
        );
        await expect(store.deleteAttachment(card.id, attachmentId)).rejects.toThrow(
          /injected card update failure/,
        );
        expect(await store.get(card.id)).toEqual(before);
        expect(await store.getAttachment(attachmentId)).toBeDefined();
        expect(countRows(db, "workboard_card_attachments", attachmentId)).toBe(1);
        expect(countRows(db, "workboard_attachment_blobs", attachmentId)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("09 rolls back the card when blob removal fails after the card write", async () => {
    await withSqlite(async (store, _stores, dbPath) => {
      const card = await store.create({ title: "Blob failure" });
      const attachmentId = await attach(store, card.id);
      const before = await store.get(card.id);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          "CREATE TRIGGER fail_blob_delete BEFORE DELETE ON workboard_attachment_blobs " +
            "BEGIN SELECT RAISE(ABORT, 'injected blob delete failure'); END",
        );
        await expect(store.deleteAttachment(card.id, attachmentId)).rejects.toThrow(
          /injected blob delete failure/,
        );
        expect(await store.get(card.id)).toEqual(before);
        expect(await store.getAttachment(attachmentId)).toBeDefined();
        expect(countRows(db, "workboard_card_attachments", attachmentId)).toBe(1);
        expect(countRows(db, "workboard_attachment_blobs", attachmentId)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("10 rejects a paused stale deletion after another instance commits deletion", async () => {
    await withSqlite(async (host, _stores, dbPath) => {
      const operationStores = createWorkboardSqliteStores({ dbPath });
      let signalReached = () => {};
      let signalResume = () => {};
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        signalResume = resolve;
      });
      const delayedCards = new Proxy(operationStores.cards, {
        get(target, property) {
          if (property === "deleteAttachmentIfUpdatedAt") {
            return async (
              ...args: Parameters<NonNullable<WorkboardCardStore["deleteAttachmentIfUpdatedAt"]>>
            ) => {
              signalReached();
              await resume;
              return await target.deleteAttachmentIfUpdatedAt!(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const operation = new WorkboardStore(delayedCards, {
        attachments: operationStores.attachments,
      });
      try {
        const card = await host.create({ title: "Two instances" });
        const attachmentId = await attach(host, card.id);
        const pending = operation.deleteAttachment(card.id, attachmentId);
        await reached;
        const winner = await host.deleteAttachment(card.id, attachmentId);
        signalResume();
        await expect(pending).rejects.toThrow(/attachment not found/);
        expect(winner.metadata?.attachments ?? []).toHaveLength(0);
        expect((await host.get(card.id))?.metadata?.attachments ?? []).toHaveLength(0);
        expect(await host.getAttachment(attachmentId)).toBeUndefined();
        const db = new DatabaseSync(dbPath);
        try {
          expect(countRows(db, "workboard_card_attachments", attachmentId)).toBe(0);
          expect(countRows(db, "workboard_attachment_blobs", attachmentId)).toBe(0);
        } finally {
          db.close();
        }
      } finally {
        signalResume();
        await operation.close();
        operationStores.close();
      }
    });
  });
});
