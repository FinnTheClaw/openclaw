import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  archiveLegacyStateSource,
  legacyStateFileExists,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "../dreaming-ingestion-state.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SESSION_SEEN_HASHES_PER_CHUNK,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
  memoryCoreWorkspaceEntryKey,
  memoryCoreWorkspaceStateKey,
  readMemoryCoreWorkspaceEntries,
} from "../dreaming-state.js";
// Import from the defining modules, not the short-term-promotion barrel: the
// barrel pulls memory-host-events/kysely, which doctor enumeration cold-loads.
import { normalizeShortTermPhaseSignalStore } from "../short-term-promotion-store.js";
import { normalizeShortTermRecallStore } from "../short-term-promotion-utils.js";
import { resolveConfiguredWorkspaces } from "./doctor-workspaces.js";
import { dreamingStateComparison } from "./dreaming-state-comparison.js";

type LegacySource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

const LEGACY_DREAMING_STATE_DIR = path.join("memory", ".dreams");

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const workspaceDir of await resolveConfiguredWorkspaces(config, env)) {
    const candidates = [
      { label: "daily ingestion", fileName: "daily-ingestion.json" },
      { label: "session ingestion", fileName: "session-ingestion.json" },
      { label: "short-term recall", fileName: "short-term-recall.json" },
      { label: "phase signals", fileName: "phase-signals.json" },
    ];
    for (const candidate of candidates) {
      const filePath = path.join(workspaceDir, LEGACY_DREAMING_STATE_DIR, candidate.fileName);
      if (await legacyStateFileExists(filePath)) {
        sources.push({ workspaceDir, label: candidate.label, filePath });
      }
    }
  }
  return sources;
}

type ImportGroup = {
  namespace: string;
  entries: Array<{ key: string; value: unknown }>;
};

async function prepareSource(source: LegacySource): Promise<ImportGroup[]> {
  const raw = await readJsonFile(source.filePath);
  if (source.label === "daily ingestion") {
    const state = normalizeDailyIngestionState(raw);
    return [
      {
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
      },
    ];
  }
  if (source.label === "session ingestion") {
    const state = normalizeSessionIngestionState(raw);
    return [
      {
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
      },
      {
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        entries: Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
          Array.from(
            { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
            (_, index) => ({
              key: `${scope}:${index}`,
              value: {
                scope,
                index,
                hashes: hashes.slice(
                  index * SESSION_SEEN_HASHES_PER_CHUNK,
                  (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
                ),
              },
            }),
          ),
        ),
      },
    ];
  }
  const recall = source.label === "short-term recall";
  const metaKey = recall ? "recall" : "phase";
  const meta = await readMemoryCoreWorkspaceEntries<{ updatedAt?: string }>({
    namespace: SHORT_TERM_META_NAMESPACE,
    workspaceDir: source.workspaceDir,
  });
  const nowIso =
    meta.find((row) => row.key === metaKey)?.value.updatedAt ?? new Date().toISOString();
  let state = recall
    ? normalizeShortTermRecallStore(raw, nowIso)
    : normalizeShortTermPhaseSignalStore(raw, nowIso);
  if (recall) {
    const rows = await readMemoryCoreWorkspaceEntries<{
      firstRecalledAt: string;
      lastRecalledAt: string;
    }>({ namespace: SHORT_TERM_RECALL_NAMESPACE, workspaceDir: source.workspaceDir });
    // A previous batch may commit before its metadata. Recover its normalization
    // timestamp only when the complete persisted subset matches the legacy source.
    const candidates = new Set(
      rows.flatMap((row) => [row.value.firstRecalledAt, row.value.lastRecalledAt]),
    );
    for (const candidate of candidates) {
      const normalized = normalizeShortTermRecallStore(raw, candidate);
      if (rows.every((row) => isDeepStrictEqual(normalized.entries[row.key], row.value))) {
        state = normalized;
        break;
      }
    }
  }
  return [
    {
      namespace: recall ? SHORT_TERM_RECALL_NAMESPACE : SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    },
    {
      namespace: SHORT_TERM_META_NAMESPACE,
      entries: [{ key: metaKey, value: { updatedAt: state.updatedAt } }],
    },
  ];
}

export const dreamingStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-dreams-json-to-sqlite",
  label: "Memory Core dreaming state",
  async detectLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const sources = await collectLegacySources(params.config, params.env);
    if (sources.length === 0) {
      return null;
    }
    return {
      preview: sources.map(
        (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
      ),
    };
  },
  async migrateLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const changes: string[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    for (const source of await collectLegacySources(params.config, params.env)) {
      let groups: ImportGroup[];
      try {
        groups = await prepareSource(source);
      } catch (err) {
        warnings.push(`Skipped Memory Core ${source.label} import: ${String(err)}`);
        continue;
      }
      const existingGroups = await Promise.all(
        groups.map((group) =>
          readMemoryCoreWorkspaceEntries({
            namespace: group.namespace,
            workspaceDir: source.workspaceDir,
          }),
        ),
      );
      const targetHasRows = await dreamingStateComparison.targetHasRows(source);
      if (targetHasRows) {
        let sourceAcknowledged: boolean;
        try {
          sourceAcknowledged = await dreamingStateComparison.sourceIsAcknowledged(source);
        } catch (err) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be compared: ${String(err)}`,
          );
          continue;
        }
        if (sourceAcknowledged) {
          // Older releases may rewrite these rollback sources. The stored hash
          // keeps unchanged sources informational; rewritten sources fail closed.
          notices.push(
            `Retained acknowledged Memory Core ${source.label} legacy source for rollback: ${source.filePath}`,
          );
          continue;
        }
        // Equal subsets can be a previous interrupted import. Only genuinely
        // divergent rows are canonical conflicts; never archive an incomplete import.
        const conflicting = groups.some((group, index) => {
          const expected = new Map(group.entries.map((row) => [row.key, row.value]));
          return existingGroups[index].some(
            (row) =>
              (group.namespace !== SHORT_TERM_META_NAMESPACE || expected.has(row.key)) &&
              (!expected.has(row.key) || !isDeepStrictEqual(expected.get(row.key), row.value)),
          );
        });
        if (conflicting) {
          changes.push(
            `Resolved Memory Core ${source.label} legacy conflict by keeping canonical SQLite plugin state`,
          );
          await archiveLegacyStateSource({
            filePath: source.filePath,
            label: `Memory Core ${source.label} conflicting legacy source`,
            changes,
            warnings,
          });
          continue;
        }
      }
      let imported = 0;
      try {
        const { importPluginStateEntries, getPluginStateCapacity } = params.context;
        if (!importPluginStateEntries || !getPluginStateCapacity) {
          throw new Error("Doctor host does not provide bounded state import");
        }
        const missingGroups = groups.map((group, index) => {
          const existing = new Set(existingGroups[index].map((row) => row.key));
          return { ...group, entries: group.entries.filter((row) => !existing.has(row.key)) };
        });
        const missing = missingGroups.reduce((sum, group) => sum + group.entries.length, 0);
        // Doctor owns the offline maintenance lock. No await between the final
        // capacity check and synchronous imports: no writer can consume the room
        // or cause eviction of earlier imported or unrelated workspace rows.
        const capacity = getPluginStateCapacity();
        if (
          capacity.liveEntries + missing >
          Math.min(capacity.maxEntries, DREAMING_WORKSPACE_STATE_MAX_ENTRIES)
        ) {
          throw new Error("Plugin state capacity cannot retain the complete legacy source");
        }
        const workspaceKey = memoryCoreWorkspaceStateKey(source.workspaceDir);
        for (const group of missingGroups) {
          importPluginStateEntries(
            {
              namespace: group.namespace,
              maxEntries: DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
            },
            group.entries.map((row) => ({
              key: memoryCoreWorkspaceEntryKey(source.workspaceDir, row.key),
              value: {
                version: 1,
                workspaceKey,
                workspaceDir: path.resolve(source.workspaceDir),
                key: row.key,
                value: row.value,
              },
              createdAt: Date.now(),
            })),
          );
          if (group.namespace !== SHORT_TERM_META_NAMESPACE) {
            imported += group.entries.length;
          }
        }
        for (const group of groups) {
          const retained = new Map(
            (
              await readMemoryCoreWorkspaceEntries({
                namespace: group.namespace,
                workspaceDir: source.workspaceDir,
              })
            ).map((row) => [row.key, row.value]),
          );
          if (group.entries.some((row) => !isDeepStrictEqual(retained.get(row.key), row.value))) {
            throw new Error("Plugin state did not retain the complete legacy source");
          }
        }
      } catch (err) {
        warnings.push(
          `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be imported: ${String(err)}`,
        );
        continue;
      }
      changes.push(
        `Migrated Memory Core ${source.label} -> SQLite plugin state (${imported} row(s))`,
      );
      await archiveLegacyStateSource({
        filePath: source.filePath,
        label: `Memory Core ${source.label}`,
        changes,
        warnings,
      });
    }
    return {
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  },
};
