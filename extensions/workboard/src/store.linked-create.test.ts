import { expect, it } from "vitest";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

it("rejects a same-key retry for an imported child missing its live parent link", async () => {
  const { store, stores } = createWorkboardSqliteTestHarness();
  const parent = await store.create({ title: "Live parent" });
  const request = { title: "Imported child", parents: [parent.id], idempotencyKey: "partial" };
  const child = await store.create({ title: request.title });
  await stores.cards.register(child.id, {
    version: 1,
    card: {
      ...child,
      metadata: {
        automation: { createdByCardId: parent.id, idempotencyKey: request.idempotencyKey },
      },
    },
  });

  const imported = await store.get(child.id);
  expect(imported?.metadata?.automation).toMatchObject({ createdByCardId: parent.id });
  await expect(store.create(request)).rejects.toThrow(
    "Existing Workboard card is missing its requested parent dependency.",
  );
  await expect(store.get(child.id)).resolves.toEqual(imported);
  await expect(store.get(parent.id)).resolves.toEqual(parent);
});

it("reuses a fully linked child on an ordinary idempotent create retry", async () => {
  const store = createWorkboardSqliteTestStore();
  const parent = await store.create({ title: "Parent" });
  const request = { title: "Child", parents: [parent.id], idempotencyKey: "linked" };
  const child = await store.create(request);

  expect(child.metadata?.links).toMatchObject([{ type: "parent", targetCardId: parent.id }]);
  await expect(store.create(request)).resolves.toEqual(child);
  await expect(store.get(parent.id)).resolves.toMatchObject({
    metadata: { links: [{ type: "child", targetCardId: child.id }] },
  });
});
