/** Isolated, fixed-location disposable canary sink for later governor rollout. */
import fs from "node:fs";
import path from "node:path";
import { Kysely } from "kysely";
import { NodeSqliteKyselyDialect } from "../infra/kysely-node-sqlite.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type {
  HostCompiledSender,
  HostPrimitiveDeliveryResult,
} from "./governor-host-channel-delivery.js";

const DELIVERY_KEY = /^[a-f0-9]{64}$/u;

type CanaryDatabase = {
  receipts: {
    delivery_key: string;
    payload_digest: string;
    created_at: number;
  };
};

const operationsByPath = new Map<string, Promise<void>>();

function canaryDatabasePath(stateDir: string): string {
  const root = path.resolve(stateDir);
  const directory = path.resolve(root, "governor-canary", "disposable-v1");
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error("Governor canary sink escaped its allowlisted state directory");
  }
  return path.join(directory, "receipts.sqlite3");
}

async function serializeCanaryOperation<T>(pathname: string, run: () => Promise<T>): Promise<T> {
  const preceding = operationsByPath.get(pathname) ?? Promise.resolve();
  const operation = preceding.catch(() => undefined).then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  operationsByPath.set(pathname, settled);
  try {
    return await operation;
  } finally {
    if (operationsByPath.get(pathname) === settled) {
      operationsByPath.delete(pathname);
    }
  }
}

async function withCanaryDatabase<T>(
  stateDir: string,
  options: { readOnly?: boolean },
  run: (db: Kysely<CanaryDatabase>) => Promise<T>,
): Promise<T> {
  const databasePath = canaryDatabasePath(stateDir);
  return serializeCanaryOperation(databasePath, async () => {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const sqlite = requireNodeSqlite();
    const db = new Kysely<CanaryDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: () => new sqlite.DatabaseSync(databasePath, options),
        transactionMode: "immediate",
      }),
    });
    try {
      if (!options.readOnly) {
        await db.schema
          .createTable("receipts")
          .ifNotExists()
          .addColumn("delivery_key", "text", (column) => column.primaryKey())
          .addColumn("payload_digest", "text", (column) => column.notNull())
          .addColumn("created_at", "integer", (column) => column.notNull())
          .execute();
      }
      return await run(db);
    } finally {
      await db.destroy();
    }
  });
}

function parseConfig(value: GovernorJsonValue): "active" | "shadow" {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Governor canary config must be an object");
  }
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(["mode", "sinkId"])) {
    throw new Error("Governor canary config contains unknown fields");
  }
  if (value.sinkId !== "disposable-v1") {
    throw new Error("Governor canary sink is not allowlisted");
  }
  if (value.mode !== "active" && value.mode !== "shadow") {
    throw new Error("Governor canary mode must be active or shadow");
  }
  return value.mode;
}

export function createCanaryHostSender(
  config: GovernorJsonValue,
  stateDir: string,
): HostCompiledSender {
  const mode = parseConfig(config);
  return Object.freeze({
    channel: "canary" as const,
    accountId: "disposable-v1",
    normalizedTarget: "receipt-sink",
    mode,
    send: async ({ deliveryKey, payload }): Promise<HostPrimitiveDeliveryResult> => {
      if (!DELIVERY_KEY.test(deliveryKey)) {
        return {
          status: "not_sent",
          reasonDigest: governorDigest({ reason: "invalid_delivery_key" }),
        };
      }
      const payloadDigest = governorDigest(payload);
      await withCanaryDatabase(stateDir, {}, async (db) => {
        await db
          .insertInto("receipts")
          .values({
            delivery_key: deliveryKey,
            payload_digest: payloadDigest,
            created_at: Date.now(),
          })
          .onConflict((conflict) => conflict.column("delivery_key").doNothing())
          .execute();
        const row = await db
          .selectFrom("receipts")
          .select("payload_digest")
          .where("delivery_key", "=", deliveryKey)
          .executeTakeFirst();
        if (row?.payload_digest !== payloadDigest) {
          throw new Error("Governor canary delivery key was reused for a different payload");
        }
      });
      return {
        status: "sent",
        providerReceipt: { sink: "disposable-v1", deliveryKey, payloadDigest },
      };
    },
    reconcile: async ({ deliveryKey, payloadDigest }) => {
      if (!DELIVERY_KEY.test(deliveryKey)) {
        return { status: "unresolved" as const };
      }
      const databasePath = canaryDatabasePath(stateDir);
      if (!fs.existsSync(databasePath)) {
        return { status: "not_sent" as const };
      }
      return withCanaryDatabase(stateDir, { readOnly: true }, async (db) => {
        const row = await db
          .selectFrom("receipts")
          .select("payload_digest")
          .where("delivery_key", "=", deliveryKey)
          .executeTakeFirst();
        if (!row) {
          return { status: "not_sent" as const };
        }
        if (row.payload_digest !== payloadDigest) {
          return { status: "unresolved" as const };
        }
        return {
          status: "sent" as const,
          providerReceipt: { sink: "disposable-v1", deliveryKey, payloadDigest },
        };
      });
    },
  });
}
