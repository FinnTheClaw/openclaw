import fs from "node:fs/promises";
import type { SessionEntrySummary } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  retryTransientMemoryRead,
  type MemorySource,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readSessionResetRecallCutoffMetadata } from "../session-reset-recall-metadata.js";
import { prepareSessionIndexInWorker } from "./manager-cpu-worker-runtime.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import type { MemoryIndexEntry } from "./manager-index-preparation.js";
import type { SessionIndexPreparation } from "./manager-session-index-preparation.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

export async function readMemoryIndexSource({
  absolutePath,
  workspaceDir,
  source,
  memoryFiles,
}: {
  absolutePath: string;
  workspaceDir: string;
  source: MemorySource;
  memoryFiles?: MemoryWorkspaceFiles;
}) {
  const remoteRead =
    source === "memory" && memoryFiles
      ? await retryTransientMemoryRead(
          () => memoryFiles.readForIndexing(absolutePath),
          `read workspace memory for indexing ${absolutePath}`,
        ).catch((error: unknown) => {
          if (!isFileMissingError(error)) {
            throw error;
          }
          return null;
        })
      : undefined;
  if (remoteRead === null) {
    return null;
  }
  const pathClassification = await resolveMemoryPathClassification({
    absolutePath,
    source,
    workspaceDir,
    readSource: remoteRead,
  });
  const content =
    remoteRead?.content ??
    (await retryTransientMemoryRead(
      () => fs.readFile(absolutePath, "utf-8"),
      `read memory markdown for indexing ${absolutePath}`,
    ).catch((err: unknown) => {
      if (source !== "memory" || !isFileMissingError(err)) {
        throw err;
      }
      return null;
    }));
  if (content === null) {
    return null;
  }
  return { content, pathClassification };
}

export function sessionIndexSourceHash(entry: Pick<SessionEntrySummary, "hash" | "revisionMs">) {
  return entry.revisionMs === undefined ? entry.hash : `sqlite:${entry.revisionMs}:${entry.hash}`;
}

/** Stream bounded pages, but publish chunks only with their captured source fingerprint. */
export async function prepareSessionIndexSource(
  entry: MemoryIndexEntry,
  settings: Omit<SessionIndexPreparation, "pathClassification" | "cutoffLine">,
  workspaceDir: string,
) {
  const streamExport = entry.streamSessionExport;
  if (!streamExport) {
    throw new Error("Session index entries stream their export");
  }
  const cutoff = readSessionResetRecallCutoffMetadata(entry);
  let sourceChanged = false;
  const prepared = await prepareSessionIndexInWorker(
    {
      ...settings,
      cutoffLine: cutoff.state === "valid" ? cutoff.cutoffLine : undefined,
      pathClassification: await resolveMemoryPathClassification({
        absolutePath: entry.absPath,
        source: "sessions",
        workspaceDir,
      }),
    },
    async (stream) => {
      const summary = await streamExport(stream);
      sourceChanged =
        summary !== null &&
        (sessionIndexSourceHash(summary) !== entry.hash ||
          summary.mtimeMs !== entry.mtimeMs ||
          summary.size !== entry.size);
      return summary;
    },
  );
  if (sourceChanged) {
    throw new MemoryIndexRevisionConflictError(
      "Session transcript changed during index preparation; retry memory sync.",
    );
  }
  return prepared;
}
