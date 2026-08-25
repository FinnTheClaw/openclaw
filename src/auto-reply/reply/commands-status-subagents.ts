// Formats subagent status rows for the status command response.
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatRunLabel, formatRunStatus, sortSubagentRuns } from "./subagents-utils.js";

function formatActiveSubagentDetail(params: {
  entry: SubagentRunRecord;
  now: number;
  pendingDescendants: number;
}): string {
  const { entry, now, pendingDescendants } = params;
  const startedAt = entry.startedAt ?? entry.sessionStartedAt ?? entry.createdAt;
  const durationMs = Math.max(
    0,
    (entry.endedAt && pendingDescendants === 0 ? entry.endedAt : now) - startedAt,
  );
  const duration = formatDurationCompact(durationMs, { spaced: true }) ?? "0s";
  const label = formatRunLabel(entry, { maxLength: 56 });
  const descendantText =
    pendingDescendants > 0
      ? ` · ${pendingDescendants} child${pendingDescendants === 1 ? "" : "ren"} active`
      : "";
  return `  • ${label} · ${duration}${descendantText}`;
}

/** Builds the compact status line for active and completed subagents. */
export function buildSubagentsStatusLine(params: {
  runs: SubagentRunRecord[];
  verboseEnabled: boolean;
  pendingDescendantsForRun: (entry: SubagentRunRecord) => number;
  now?: number;
}): string | undefined {
  const { runs, pendingDescendantsForRun, verboseEnabled } = params;
  if (runs.length === 0) {
    return undefined;
  }
  const activeWithDescendants = runs
    .map((entry) => ({ entry, pendingDescendants: pendingDescendantsForRun(entry) }))
    .filter(({ entry, pendingDescendants }) => !entry.endedAt || pendingDescendants > 0);
  const active = activeWithDescendants.map(({ entry }) => entry);
  const activeRunIds = new Set(active.map((entry) => entry.runId));
  const settledStatuses = runs
    .filter((entry) => !activeRunIds.has(entry.runId))
    .map((entry) => formatRunStatus(entry));
  const done = settledStatuses.filter((status) => status === "done").length;
  const blocked = settledStatuses.filter((status) => status === "blocked").length;
  const issues = settledStatuses.length - done - blocked;
  const settledSummary = [
    done > 0 ? `${done} done` : undefined,
    blocked > 0 ? `${blocked} blocked` : undefined,
    issues > 0 ? `${issues} issue${issues === 1 ? "" : "s"}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (active.length === 0) {
    return verboseEnabled && settledSummary.length > 0
      ? `🤖 Subagents: 0 active · ${settledSummary.join(" · ")}`
      : undefined;
  }

  const summary = `🤖 Subagents: ${active.length} active${
    settledSummary.length > 0 ? ` · ${settledSummary.join(" · ")}` : ""
  }`;
  const now = params.now ?? Date.now();
  const detailLookup = new Map(
    activeWithDescendants.map(({ entry, pendingDescendants }) => [entry.runId, pendingDescendants]),
  );
  const detailLines = sortSubagentRuns(active)
    .slice(0, 3)
    .map((entry) =>
      formatActiveSubagentDetail({
        entry,
        now,
        pendingDescendants: detailLookup.get(entry.runId) ?? 0,
      }),
    );
  return [summary, ...detailLines].join("\n");
}
