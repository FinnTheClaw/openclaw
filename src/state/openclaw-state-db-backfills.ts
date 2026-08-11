import type { DatabaseSync } from "node:sqlite";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-utils.js";

export function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: Number(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonField(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function cronSessionTargetField(record: Record<string, unknown>): string | null {
  const value = textField(record, "sessionTarget");
  if (!value) {
    return null;
  }
  return value === "main" ||
    value === "isolated" ||
    value === "current" ||
    value.startsWith("session:")
    ? value
    : null;
}

function cronWakeModeField(record: Record<string, unknown>): string | null {
  const value = textField(record, "wakeMode");
  return value === "now" || value === "next-heartbeat" ? value : null;
}

function booleanField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function failureDestinationField(
  record: Record<string, unknown> | null,
  key: "accountId" | "channel" | "mode" | "to",
): string | null {
  if (!record || !Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : "";
}

export function migrateLegacyCronDeliveryThreadIds(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, delivery_thread_id
         FROM cron_jobs
        WHERE delivery_thread_id_type IS NULL`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    delivery_thread_id: string | null;
  }>;
  const update = db.prepare(
    `UPDATE cron_jobs
        SET delivery_thread_id = ?, delivery_thread_id_type = ?
      WHERE store_key = ? AND job_id = ? AND delivery_thread_id_type IS NULL`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    const delivery = job ? recordField(job, "delivery") : null;
    const typed = delivery?.threadId;
    if (row.delivery_thread_id === null) {
      if (typeof typed === "number" && Number.isFinite(typed)) {
        update.run(String(typed), "number", row.store_key, row.job_id);
      }
      continue;
    }
    const type =
      typeof typed === "number" &&
      Number.isFinite(typed) &&
      String(typed) === row.delivery_thread_id
        ? "number"
        : "string";
    update.run(row.delivery_thread_id, type, row.store_key, row.job_id);
  }
}

export function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "cron_jobs") ||
    !tableHasColumn(db, "cron_jobs", "job_json") ||
    !tableHasColumn(db, "cron_jobs", "schedule_kind") ||
    !tableHasColumn(db, "cron_jobs", "payload_kind")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at
         FROM cron_jobs
        WHERE schedule_kind = 'manual'
           OR payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            delete_after_run = ?,
            created_at_ms = ?,
            agent_id = ?,
            session_key = ?,
            schedule_kind = ?,
            schedule_expr = ?,
            schedule_tz = ?,
            every_ms = ?,
            anchor_ms = ?,
            at = ?,
            stagger_ms = ?,
            session_target = ?,
            wake_mode = ?,
            payload_kind = ?,
            payload_message = ?,
            payload_model = ?,
            payload_fallbacks_json = ?,
            payload_thinking = ?,
            payload_timeout_seconds = ?,
            payload_allow_unsafe_external_content = ?,
            payload_external_content_source_json = ?,
            payload_light_context = ?,
            payload_tools_allow_json = ?,
            delivery_mode = ?,
            delivery_channel = ?,
            delivery_to = ?,
            delivery_thread_id = ?,
            delivery_account_id = ?,
            delivery_best_effort = ?,
            delivery_completion_mode = ?,
            delivery_completion_to = ?,
            failure_delivery_mode = ?,
            failure_delivery_channel = ?,
            failure_delivery_to = ?,
            failure_delivery_account_id = ?,
            failure_alert_disabled = ?,
            failure_alert_after = ?,
            failure_alert_channel = ?,
            failure_alert_to = ?,
            failure_alert_cooldown_ms = ?,
            failure_alert_include_skipped = ?,
            failure_alert_mode = ?,
            failure_alert_account_id = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    if (!job) {
      continue;
    }
    const schedule = recordField(job, "schedule");
    const payload = recordField(job, "payload");
    const scheduleKind = textField(schedule ?? {}, "kind");
    const payloadKind = textField(payload ?? {}, "kind");
    const isAt = scheduleKind === "at" && textField(schedule ?? {}, "at");
    const isEvery = scheduleKind === "every" && numberField(schedule ?? {}, "everyMs") != null;
    const isCron = scheduleKind === "cron" && textField(schedule ?? {}, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload ?? {}, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload ?? {}, "message");
    if (
      !schedule ||
      !payload ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    const fallbackTime = Number(row.updated_at) || 0;
    const delivery = recordField(job, "delivery");
    const completionDestination = delivery ? recordField(delivery, "completionDestination") : null;
    const failureDestination = delivery ? recordField(delivery, "failureDestination") : null;
    const failureAlertValue = job.failureAlert;
    const failureAlert =
      failureAlertValue &&
      typeof failureAlertValue === "object" &&
      !Array.isArray(failureAlertValue)
        ? (failureAlertValue as Record<string, unknown>)
        : null;
    update.run(
      textField(job, "name") ?? row.job_id,
      job.enabled === false ? 0 : 1,
      booleanField(job, "deleteAfterRun"),
      numberField(job, "createdAtMs") ?? fallbackTime,
      textField(job, "agentId"),
      textField(job, "sessionKey"),
      scheduleKind,
      isCron ? textField(schedule, "expr") : null,
      isCron ? textField(schedule, "tz") : null,
      isEvery ? numberField(schedule, "everyMs") : null,
      isEvery ? numberField(schedule, "anchorMs") : null,
      isAt ? textField(schedule, "at") : null,
      isCron ? numberField(schedule, "staggerMs") : null,
      cronSessionTargetField(job) ?? (payloadKind === "agentTurn" ? "isolated" : "main"),
      cronWakeModeField(job) ?? "now",
      payloadKind,
      isSystemEvent ? textField(payload, "text") : textField(payload, "message"),
      isAgentTurn ? textField(payload, "model") : null,
      isAgentTurn ? jsonField(payload.fallbacks) : null,
      isAgentTurn ? textField(payload, "thinking") : null,
      isAgentTurn ? numberField(payload, "timeoutSeconds") : null,
      isAgentTurn && typeof payload.allowUnsafeExternalContent === "boolean"
        ? payload.allowUnsafeExternalContent
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.externalContentSource) : null,
      isAgentTurn && typeof payload.lightContext === "boolean"
        ? payload.lightContext
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.toolsAllow) : null,
      delivery ? textField(delivery, "mode") : null,
      delivery ? textField(delivery, "channel") : null,
      delivery ? textField(delivery, "to") : null,
      delivery ? textField(delivery, "threadId") : null,
      delivery ? textField(delivery, "accountId") : null,
      delivery && typeof delivery.bestEffort === "boolean" ? (delivery.bestEffort ? 1 : 0) : null,
      completionDestination ? textField(completionDestination, "mode") : null,
      completionDestination ? textField(completionDestination, "to") : null,
      failureDestinationField(failureDestination, "mode"),
      failureDestinationField(failureDestination, "channel"),
      failureDestinationField(failureDestination, "to"),
      failureDestinationField(failureDestination, "accountId"),
      failureAlertValue === false ? 1 : failureAlert ? 0 : null,
      failureAlert ? numberField(failureAlert, "after") : null,
      failureAlert ? textField(failureAlert, "channel") : null,
      failureAlert ? textField(failureAlert, "to") : null,
      failureAlert ? numberField(failureAlert, "cooldownMs") : null,
      failureAlert && typeof failureAlert.includeSkipped === "boolean"
        ? failureAlert.includeSkipped
          ? 1
          : 0
        : null,
      failureAlert ? textField(failureAlert, "mode") : null,
      failureAlert ? textField(failureAlert, "accountId") : null,
      numberField(job, "updatedAtMs") ?? fallbackTime,
      row.store_key,
      row.job_id,
    );
  }
}

function metadataStringField(record: Record<string, unknown>, key: string): string | null {
  return textField(record, key);
}

export function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "delivery_queue_entries") ||
    !tableHasColumn(db, "delivery_queue_entries", "entry_json") ||
    !tableHasColumn(db, "delivery_queue_entries", "retry_count")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json
         FROM delivery_queue_entries
        WHERE retry_count = 0
           OR last_attempt_at IS NULL
           OR last_error IS NULL
           OR recovery_state IS NULL
           OR platform_send_started_at IS NULL
           OR entry_kind IS NULL
           OR session_key IS NULL
           OR channel IS NULL
           OR target IS NULL
           OR account_id IS NULL`,
    )
    .all() as Array<{ queue_name: string; id: string; entry_json: string }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const row of rows) {
    const entry = parseJsonRecord(row.entry_json);
    if (!entry) {
      continue;
    }
    const session = recordField(entry, "session");
    const route = recordField(entry, "route");
    const deliveryContext = recordField(entry, "deliveryContext");
    update.run(
      metadataStringField(entry, "kind"),
      metadataStringField(entry, "sessionKey") ??
        (session ? metadataStringField(session, "key") : null),
      metadataStringField(entry, "channel") ??
        (route ? metadataStringField(route, "channel") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "channel") : null),
      metadataStringField(entry, "to") ??
        (route ? metadataStringField(route, "to") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "to") : null),
      metadataStringField(entry, "accountId") ??
        (route ? metadataStringField(route, "accountId") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "accountId") : null),
      numberField(entry, "retryCount") ?? 0,
      numberField(entry, "lastAttemptAt"),
      metadataStringField(entry, "lastError"),
      metadataStringField(entry, "recoveryState"),
      numberField(entry, "platformSendStartedAt"),
      row.queue_name,
      row.id,
    );
  }
}
