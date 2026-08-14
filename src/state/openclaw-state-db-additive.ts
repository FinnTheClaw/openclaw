import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  backfillCronJobsFromJobJson,
  backfillCronRunLogEntryJson,
  backfillDeliveryQueueEntriesFromEntryJson,
  migrateLegacyCronDeliveryThreadIds,
} from "./openclaw-state-db-backfills.js";
import {
  ensureStateColumn,
  repairLegacyTaskAgentAttribution,
  repairLegacyTaskDeliveryStatuses,
} from "./openclaw-state-db-schema-utils.js";

export function rebuildLegacyChildIntentUniqueness(db: DatabaseSync): void {
  const indexes = db.prepare("PRAGMA index_list('subagent_child_intents')").all() as Array<{
    name?: unknown;
    origin?: unknown;
  }>;
  if (
    !indexes.some(
      (index) => index.origin === "u" && String(index.name).startsWith("sqlite_autoindex"),
    )
  ) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(`
      CREATE TABLE subagent_child_intents_v2 (
        intent_id TEXT NOT NULL PRIMARY KEY,
        controller_session_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        operation_key TEXT,
        request_digest TEXT NOT NULL,
        preparation_digest TEXT NOT NULL DEFAULT '',
        resolved_digest TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        child_session_key TEXT NOT NULL,
        reservation_run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at INTEGER,
        registered_run_id TEXT,
        provider_run_id TEXT,
        gateway_receipt_id TEXT,
        cancel_requested_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO subagent_child_intents_v2
        SELECT intent_id, controller_session_key, canonical_key, operation_key,
          request_digest, preparation_digest, resolved_digest, target_agent_id,
          child_session_key, reservation_run_id, state, generation, lease_owner,
          lease_expires_at, registered_run_id, provider_run_id, gateway_receipt_id,
          cancel_requested_at, created_at, updated_at, payload_json
        FROM subagent_child_intents;
      DROP TABLE subagent_child_intents;
      ALTER TABLE subagent_child_intents_v2 RENAME TO subagent_child_intents;
      CREATE INDEX idx_subagent_child_intents_active_controller
        ON subagent_child_intents(controller_session_key, state, lease_expires_at);
      CREATE INDEX idx_subagent_child_intents_controller_canonical
        ON subagent_child_intents(controller_session_key, canonical_key);
      CREATE INDEX idx_subagent_child_intents_registered_run
        ON subagent_child_intents(registered_run_id);
      CREATE UNIQUE INDEX uq_subagent_child_intents_controller_operation
        ON subagent_child_intents(controller_session_key, operation_key)
        WHERE operation_key IS NOT NULL;
      CREATE UNIQUE INDEX uq_subagent_child_intents_controller_canonical
        ON subagent_child_intents(controller_session_key, canonical_key)
        WHERE operation_key IS NULL;
    `);
  });
}

export function ensureAdditiveStateColumns(db: DatabaseSync): void {
  const add = (table: string, column: string) => ensureStateColumn(db, table, column);
  add("node_pairing_pending", "client_id TEXT");
  add("node_pairing_pending", "client_mode TEXT");
  add("node_pairing_paired", "client_id TEXT");
  add("node_pairing_paired", "client_mode TEXT");
  for (const column of [
    "status TEXT",
    "error TEXT",
    "summary TEXT",
    "diagnostics_summary TEXT",
    "delivery_status TEXT",
    "delivery_error TEXT",
    "delivered INTEGER",
    "session_id TEXT",
    "session_key TEXT",
    "run_id TEXT",
    "run_at_ms INTEGER",
    "duration_ms INTEGER",
    "next_run_at_ms INTEGER",
    "model TEXT",
    "provider TEXT",
    "total_tokens INTEGER",
    "entry_json TEXT NOT NULL DEFAULT '{}'",
    "created_at INTEGER NOT NULL DEFAULT 0",
  ]) {
    add("cron_run_logs", column);
  }
  backfillCronRunLogEntryJson(db);
  for (const column of [
    "description TEXT",
    "declaration_key TEXT",
    "display_name TEXT",
    "owner_agent_id TEXT",
    "owner_session_key TEXT",
    "name TEXT NOT NULL DEFAULT ''",
    "enabled INTEGER NOT NULL DEFAULT 1",
    "delete_after_run INTEGER",
    "created_at_ms INTEGER NOT NULL DEFAULT 0",
    "agent_id TEXT",
    "session_key TEXT",
    "schedule_kind TEXT NOT NULL DEFAULT 'manual'",
    "schedule_expr TEXT",
    "schedule_tz TEXT",
    "every_ms INTEGER",
    "anchor_ms INTEGER",
    "at TEXT",
    "stagger_ms INTEGER",
    "session_target TEXT NOT NULL DEFAULT 'main'",
    "wake_mode TEXT NOT NULL DEFAULT 'auto'",
    "trigger_script TEXT",
    "trigger_once INTEGER",
    "payload_kind TEXT NOT NULL DEFAULT 'message'",
    "payload_message TEXT",
    "payload_model TEXT",
    "payload_fallbacks_json TEXT",
    "payload_thinking TEXT",
    "payload_timeout_seconds INTEGER",
    "payload_allow_unsafe_external_content INTEGER",
    "payload_external_content_source_json TEXT",
    "payload_light_context INTEGER",
    "payload_tools_allow_json TEXT",
    "payload_tools_allow_is_default INTEGER",
    "delivery_mode TEXT",
    "delivery_channel TEXT",
    "delivery_to TEXT",
    "delivery_thread_id TEXT",
    "delivery_account_id TEXT",
    "delivery_best_effort INTEGER",
    "delivery_completion_mode TEXT",
    "delivery_completion_to TEXT",
    "failure_delivery_mode TEXT",
    "failure_delivery_channel TEXT",
    "failure_delivery_to TEXT",
    "failure_delivery_account_id TEXT",
    "failure_alert_disabled INTEGER",
    "failure_alert_after INTEGER",
    "failure_alert_channel TEXT",
    "failure_alert_to TEXT",
    "failure_alert_cooldown_ms INTEGER",
    "failure_alert_include_skipped INTEGER",
    "failure_alert_mode TEXT",
    "failure_alert_account_id TEXT",
    "next_run_at_ms INTEGER",
    "running_at_ms INTEGER",
    "last_run_at_ms INTEGER",
    "last_run_status TEXT",
    "last_error TEXT",
    "last_duration_ms INTEGER",
    "consecutive_errors INTEGER",
    "consecutive_skipped INTEGER",
    "schedule_error_count INTEGER",
    "last_delivery_status TEXT",
    "last_delivery_error TEXT",
    "last_delivered INTEGER",
    "last_failure_alert_at_ms INTEGER",
    "state_json TEXT NOT NULL DEFAULT '{}'",
    "runtime_updated_at_ms INTEGER",
    "schedule_identity TEXT",
    "sort_order INTEGER NOT NULL DEFAULT 0",
  ]) {
    add("cron_jobs", column);
  }
  backfillCronJobsFromJobJson(db);
  runSqliteImmediateTransactionSync(db, () => {
    if (add("cron_jobs", "delivery_thread_id_type TEXT")) {
      migrateLegacyCronDeliveryThreadIds(db);
    }
  });
  for (const column of [
    "session_key TEXT",
    "backend_id TEXT",
    "runtime_label TEXT",
    "image TEXT",
    "created_at_ms INTEGER",
    "last_used_at_ms INTEGER",
    "config_label_kind TEXT",
    "config_hash TEXT",
    "cdp_port INTEGER",
    "no_vnc_port INTEGER",
  ]) {
    add("sandbox_registry_entries", column);
  }
  for (const column of [
    "entry_kind TEXT",
    "session_key TEXT",
    "channel TEXT",
    "target TEXT",
    "account_id TEXT",
    "retry_count INTEGER NOT NULL DEFAULT 0",
    "last_attempt_at INTEGER",
    "last_error TEXT",
    "recovery_state TEXT",
    "platform_send_started_at INTEGER",
  ]) {
    add("delivery_queue_entries", column);
  }
  backfillDeliveryQueueEntriesFromEntryJson(db);
  for (const column of [
    "account_id TEXT",
    "recipient_id TEXT",
    "thread_id TEXT",
    "sender_id TEXT",
    "kind TEXT NOT NULL DEFAULT 'followup'",
    "sensitivity TEXT NOT NULL DEFAULT 'normal'",
    "source TEXT NOT NULL DEFAULT 'unknown'",
    "reason TEXT NOT NULL DEFAULT ''",
    "suggested_text TEXT NOT NULL DEFAULT ''",
    "dedupe_key TEXT NOT NULL DEFAULT ''",
    "confidence REAL NOT NULL DEFAULT 0",
    "due_timezone TEXT NOT NULL DEFAULT 'UTC'",
    "source_message_id TEXT",
    "source_run_id TEXT",
    "created_at_ms INTEGER NOT NULL DEFAULT 0",
    "attempts INTEGER NOT NULL DEFAULT 0",
    "last_attempt_at_ms INTEGER",
    "sent_at_ms INTEGER",
    "dismissed_at_ms INTEGER",
    "snoozed_until_ms INTEGER",
    "expired_at_ms INTEGER",
  ]) {
    add("commitments", column);
  }
  add("current_conversation_bindings", "target_agent_id TEXT NOT NULL DEFAULT 'main'");
  add("current_conversation_bindings", "target_session_id TEXT");
  add("current_conversation_bindings", "conversation_kind TEXT NOT NULL DEFAULT 'channel'");
  add("device_bootstrap_tokens", "pending_profile_json TEXT");
  add("gateway_restart_handoff", "restart_trace_started_at INTEGER");
  add("gateway_restart_handoff", "restart_trace_last_at INTEGER");
  add("gateway_restart_intent", "reason TEXT");
  for (const column of [
    "delivery_channel TEXT",
    "delivery_to TEXT",
    "delivery_account_id TEXT",
    "message TEXT",
    "continuation_json TEXT",
    "doctor_hint TEXT",
    "stats_json TEXT",
  ]) {
    add("gateway_restart_sentinel", column);
  }
  add("gateway_boot_lifecycle", "startup_reason TEXT");
  runSqliteImmediateTransactionSync(db, () => {
    if (add("task_runs", "requester_agent_id TEXT")) {
      repairLegacyTaskAgentAttribution(db);
    }
    repairLegacyTaskDeliveryStatuses(db);
  });
  add("subagent_runs", "task_name TEXT");
  add("subagent_runs", "projection_revision INTEGER NOT NULL DEFAULT 0");
  add("subagent_child_intents", "preparation_digest TEXT NOT NULL DEFAULT ''");
  for (const column of [
    "created_at INTEGER NOT NULL DEFAULT 0",
    "acceptance_epoch TEXT NOT NULL DEFAULT ''",
    "envelope_digest TEXT NOT NULL DEFAULT ''",
    "envelope_json TEXT NOT NULL DEFAULT '{}'",
    "key_id TEXT NOT NULL DEFAULT ''",
    "nonce TEXT NOT NULL DEFAULT ''",
    "signature TEXT NOT NULL DEFAULT ''",
    "cancel_epoch INTEGER NOT NULL DEFAULT 0",
  ]) {
    add("subagent_gateway_acceptance_receipts", column);
  }
  rebuildLegacyChildIntentUniqueness(db);
}
