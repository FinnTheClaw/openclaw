// Lazily creates governor-only state after the explicit feature path is constructed.
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { GOVERNOR_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.generated.js";

export function initializeGovernorStateSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const { db } = openOpenClawStateDatabase(options);
  db.exec(GOVERNOR_STATE_SCHEMA_SQL);
  const columns = db.prepare("PRAGMA table_info(governor_outbox)").all() as Array<{
    name?: unknown;
  }>;
  const names = new Set(
    columns.map((column) => column.name).filter((name): name is string => typeof name === "string"),
  );
  if (!names.has("plan_version")) {
    db.exec("ALTER TABLE governor_outbox ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("execution_generation")) {
    db.exec(
      "ALTER TABLE governor_outbox ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 0",
    );
  }
}
