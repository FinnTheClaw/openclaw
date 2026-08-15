import type * as LanceDB from "@lancedb/lancedb";
import { loadLanceDbModule } from "./lancedb-runtime.js";

const TABLE_NAME = "memory_items_v2";
const SCHEMA_ROW_ID = "__memory_v2_schema__";
const DEFAULT_INDEX_MIN_ROWS = 256;
const DEFAULT_OPTIMIZE_UNINDEXED_ROWS = 10_000;
const RRF_K = 60;

export type MemoryProjectionType = "event" | "fact" | "summary";
export type MemoryProjectionStatus = "active" | "superseded" | "retracted";

export type MemoryProjectionInput = {
  id: string;
  recordType: MemoryProjectionType;
  text: string;
  vector: number[];
  agentId: string;
  scope?: string;
  sessionKey?: string;
  channel?: string;
  conversationId?: string;
  factKey?: string;
  category?: string;
  status?: MemoryProjectionStatus;
  importance?: number;
  confidence?: number;
  authority?: number;
  validFrom?: number;
  validTo?: number;
  observedAt?: number;
  sourceEventId?: string;
  tags?: string[];
  updatedAt?: number;
};

export type MemoryProjectionEntry = Required<Omit<MemoryProjectionInput, "validTo" | "tags">> & {
  validTo?: number;
  tags: string[];
};

export type HybridMemorySearchOptions = {
  queryText: string;
  vector: number[];
  agentId: string;
  scope?: string;
  /** Trusted local diagnostics only: search every scope owned by one opaque principal. */
  allScopes?: boolean;
  channel?: string;
  validAt?: number;
  limit?: number;
  overfetch?: number;
  recordTypes?: MemoryProjectionType[];
};

export type HybridMemorySearchResult = {
  entry: MemoryProjectionEntry;
  score: number;
  denseRank?: number;
  lexicalRank?: number;
  denseSimilarity?: number;
  lexicalScore?: number;
};

export type HybridMemoryIndexStats = {
  rows: number;
  indices: Array<{
    name: string;
    columns: string[];
    type?: string;
    indexedRows?: number;
    unindexedRows?: number;
  }>;
};

type SearchCandidate = {
  entry: MemoryProjectionEntry;
  rank: number;
  rawScore?: number;
};

type RankedAccumulator = {
  entry: MemoryProjectionEntry;
  score: number;
  denseRank?: number;
  lexicalRank?: number;
  denseSimilarity?: number;
  lexicalScore?: number;
};

function finiteUnit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function finiteTime(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function optionalText(value: string | undefined, fallback = ""): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateVector(vector: number[], dimensions: number): number[] {
  if (vector.length !== dimensions) {
    throw new Error(`memory vector dimension ${vector.length} does not match ${dimensions}`);
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error("memory vector must contain only finite values");
  }
  if (!vector.some((value) => value !== 0)) {
    throw new Error("memory vector must not be all zeroes");
  }
  return vector;
}

function normalizeProjection(
  input: MemoryProjectionInput,
  dimensions: number,
): MemoryProjectionEntry {
  const now = Date.now();
  return {
    id: requiredText(input.id, "id"),
    recordType: input.recordType,
    text: requiredText(input.text, "text"),
    vector: validateVector(input.vector, dimensions),
    agentId: requiredText(input.agentId, "agentId"),
    scope: optionalText(input.scope, "global"),
    sessionKey: optionalText(input.sessionKey),
    channel: optionalText(input.channel),
    conversationId: optionalText(input.conversationId),
    factKey: optionalText(input.factKey),
    category: optionalText(input.category, "other"),
    status: input.status ?? "active",
    importance: finiteUnit(input.importance, 0.5),
    confidence: finiteUnit(input.confidence, 0.5),
    authority: finiteUnit(input.authority, 0.5),
    validFrom: finiteTime(input.validFrom, finiteTime(input.observedAt, now)),
    ...(input.validTo === undefined ? {} : { validTo: finiteTime(input.validTo, now) }),
    observedAt: finiteTime(input.observedAt, now),
    sourceEventId: optionalText(input.sourceEventId),
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    updatedAt: finiteTime(input.updatedAt, now),
  };
}

function toLanceRow(entry: MemoryProjectionEntry): Record<string, unknown> {
  const { tags, validTo, ...rest } = entry;
  return {
    ...rest,
    validTo: validTo ?? 0,
    tagsJson: JSON.stringify(tags),
  };
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToProjection(row: Record<string, unknown>): MemoryProjectionEntry {
  const validTo = Number(row.validTo);
  return {
    id: String(row.id),
    recordType: String(row.recordType) as MemoryProjectionType,
    text: String(row.text),
    vector: Array.from(row.vector as Iterable<number>),
    agentId: String(row.agentId),
    scope: String(row.scope),
    sessionKey: String(row.sessionKey),
    channel: String(row.channel),
    conversationId: String(row.conversationId),
    factKey: String(row.factKey),
    category: String(row.category),
    status: String(row.status) as MemoryProjectionStatus,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    authority: Number(row.authority),
    validFrom: Number(row.validFrom),
    ...(validTo > 0 ? { validTo } : {}),
    observedAt: Number(row.observedAt),
    sourceEventId: String(row.sourceEventId),
    tags: parseTags(row.tagsJson),
    updatedAt: Number(row.updatedAt),
  };
}

function buildFilter(options: HybridMemorySearchOptions): string {
  const validAt = finiteTime(options.validAt, Date.now());
  if (options.scope && options.allScopes) {
    throw new Error("memory search cannot combine scope with allScopes");
  }
  const conditions = [
    `agentId = ${sqlString(requiredText(options.agentId, "agentId"))}`,
    "status = 'active'",
    `validFrom <= ${validAt}`,
    `(validTo = 0 OR validTo > ${validAt})`,
  ];
  if (!options.allScopes) {
    conditions.splice(1, 0, `scope = ${sqlString(optionalText(options.scope, "global"))}`);
  }
  if (options.channel) {
    conditions.push(`(channel = '' OR channel = ${sqlString(options.channel)})`);
  }
  if (options.recordTypes && options.recordTypes.length > 0) {
    const values = [...new Set(options.recordTypes)].map(sqlString).join(", ");
    conditions.push(`recordType IN (${values})`);
  }
  return conditions.join(" AND ");
}

function qualityBoost(entry: MemoryProjectionEntry): number {
  // Quality can break close RRF ties, but never overpower actual retrieval rank.
  return (
    0.003 * entry.authority +
    0.002 * entry.confidence +
    0.001 * entry.importance +
    (entry.recordType === "fact" ? 0.001 : 0)
  );
}

export function reciprocalRankFuse(options: {
  dense: SearchCandidate[];
  lexical: SearchCandidate[];
  limit: number;
  denseWeight?: number;
  lexicalWeight?: number;
}): HybridMemorySearchResult[] {
  // Equal fusion prevents a dense-only near-tie from burying a rare exact
  // identifier or code surfaced by BM25. Cross-encoder reranking can be added
  // above this bounded candidate set without changing persistence semantics.
  const denseWeight = options.denseWeight ?? 0.5;
  const lexicalWeight = options.lexicalWeight ?? 0.5;
  const byId = new Map<string, RankedAccumulator>();
  const add = (candidate: SearchCandidate, kind: "dense" | "lexical", weight: number) => {
    const current = byId.get(candidate.entry.id) ?? {
      entry: candidate.entry,
      score: qualityBoost(candidate.entry),
    };
    current.score += weight / (RRF_K + candidate.rank);
    if (kind === "dense") {
      current.denseRank = candidate.rank;
      current.denseSimilarity = candidate.rawScore;
    } else {
      current.lexicalRank = candidate.rank;
      current.lexicalScore = candidate.rawScore;
    }
    byId.set(candidate.entry.id, current);
  };
  options.dense.forEach((candidate) => add(candidate, "dense", denseWeight));
  options.lexical.forEach((candidate) => add(candidate, "lexical", lexicalWeight));
  return [...byId.values()]
    .toSorted(
      (left, right) => right.score - left.score || right.entry.observedAt - left.entry.observedAt,
    )
    .slice(0, Math.max(1, options.limit));
}

function normalizedMemoryText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function deduplicateHybridResults(
  results: HybridMemorySearchResult[],
  limit: number,
): HybridMemorySearchResult[] {
  const selected = new Map<string, HybridMemorySearchResult>();
  const typePriority: Record<MemoryProjectionType, number> = {
    fact: 3,
    summary: 2,
    event: 1,
  };
  for (const result of results) {
    const key = normalizedMemoryText(result.entry.text);
    const current = selected.get(key);
    if (
      !current ||
      typePriority[result.entry.recordType] > typePriority[current.entry.recordType]
    ) {
      selected.set(key, result);
    }
  }
  return [...selected.values()]
    .toSorted(
      (left, right) => right.score - left.score || right.entry.observedAt - left.entry.observedAt,
    )
    .slice(0, Math.max(1, limit));
}

/**
 * Rebuildable hybrid search projection. The authoritative source is the
 * TemporalMemoryLedger; deleting this directory must never delete a memory.
 */
export class HybridMemoryIndex {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private module: typeof import("@lancedb/lancedb") | null = null;
  private initPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private ftsReady = false;
  private closing = false;
  private closed = false;

  constructor(
    readonly dbPath: string,
    readonly vectorDimensions: number,
    private readonly storageOptions?: Record<string, string>,
  ) {
    if (!Number.isInteger(vectorDimensions) || vectorDimensions < 1) {
      throw new Error("vectorDimensions must be a positive integer");
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.closed || this.closing) {
      throw new Error("memory index is closed");
    }
    if (this.table) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    this.module = await loadLanceDbModule();
    this.db = await this.module.connect(
      this.dbPath,
      this.storageOptions ? { storageOptions: this.storageOptions } : {},
    );
    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      const now = Date.now();
      this.table = await this.db.createTable(TABLE_NAME, [
        toLanceRow({
          id: SCHEMA_ROW_ID,
          recordType: "event",
          text: "schema",
          vector: [1, ...Array.from({ length: this.vectorDimensions - 1 }, () => 0)],
          agentId: "schema",
          scope: "schema",
          sessionKey: "",
          channel: "",
          conversationId: "",
          factKey: "",
          category: "other",
          status: "retracted",
          importance: 0,
          confidence: 0,
          authority: 0,
          validFrom: now,
          observedAt: now,
          sourceEventId: "",
          tags: [],
          updatedAt: now,
        }),
      ]);
      await this.table.delete(`id = ${sqlString(SCHEMA_ROW_ID)}`);
    }
    const indices = await this.table.listIndices();
    this.ftsReady = indices.some((index) => index.columns.includes("text"));
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(operation, operation);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async upsertBatch(inputs: MemoryProjectionInput[]): Promise<void> {
    await this.ensureInitialized();
    if (inputs.length === 0) {
      return;
    }
    if (inputs.length > 10_000) {
      throw new Error("memory projection batch must contain at most 10000 rows");
    }
    const rows = inputs.map((input) =>
      toLanceRow(normalizeProjection(input, this.vectorDimensions)),
    );
    await this.runExclusive(async () => {
      await this.table!.mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows);
      if (!this.ftsReady) {
        await this.ensureIndicesUnlocked();
      }
    });
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const normalized = requiredText(id, "id");
    return await this.runExclusive(async () => {
      const existed = (await this.table!.countRows(`id = ${sqlString(normalized)}`)) > 0;
      if (existed) {
        await this.table!.delete(`id = ${sqlString(normalized)}`);
      }
      return existed;
    });
  }

  async has(id: string, options?: { agentId?: string; scope?: string }): Promise<boolean> {
    await this.ensureInitialized();
    const conditions = [`id = ${sqlString(requiredText(id, "id"))}`];
    if (options?.agentId) {
      conditions.push(`agentId = ${sqlString(requiredText(options.agentId, "agentId"))}`);
    }
    if (options?.scope) {
      conditions.push(`scope = ${sqlString(requiredText(options.scope, "scope"))}`);
    }
    return (await this.table!.countRows(conditions.join(" AND "))) > 0;
  }

  async ensureIndices(options: { minRows?: number; force?: boolean } = {}): Promise<void> {
    await this.ensureInitialized();
    await this.runExclusive(async () => this.ensureIndicesUnlocked(options));
  }

  private async ensureIndicesUnlocked(
    options: { minRows?: number; force?: boolean } = {},
  ): Promise<void> {
    const minRows = Math.max(1, Math.floor(options.minRows ?? DEFAULT_INDEX_MIN_ROWS));
    const rows = await this.table!.countRows();
    const existing = await this.table!.listIndices();
    const byColumn = new Set(existing.flatMap((index) => index.columns));
    const Index = this.module!.Index;
    if (!byColumn.has("id")) {
      await this.table!.createIndex("id", { config: Index.btree(), replace: false });
    }
    for (const column of ["agentId", "scope", "recordType", "status", "channel"]) {
      if (!byColumn.has(column)) {
        await this.table!.createIndex(column, { config: Index.bitmap(), replace: false });
      }
    }
    if (!byColumn.has("validFrom")) {
      await this.table!.createIndex("validFrom", { config: Index.btree(), replace: false });
    }
    if (!byColumn.has("text")) {
      await this.table!.createIndex("text", {
        config: Index.fts({
          baseTokenizer: "simple",
          lowercase: true,
          stem: true,
          removeStopWords: true,
        }),
        replace: false,
      });
      this.ftsReady = true;
    }
    if (!byColumn.has("vector") && (options.force || rows >= minRows)) {
      await this.table!.createIndex("vector", {
        config: Index.hnswSq({ distanceType: "cosine", numPartitions: 1 }),
        replace: false,
      });
    }
  }

  async optimizeIfNeeded(threshold = DEFAULT_OPTIMIZE_UNINDEXED_ROWS): Promise<boolean> {
    await this.ensureInitialized();
    return await this.runExclusive(async () => {
      const indices = await this.table!.listIndices();
      let shouldOptimize = false;
      for (const index of indices) {
        const stats = await this.table!.indexStats(index.name);
        if (stats && stats.numUnindexedRows >= threshold) {
          shouldOptimize = true;
          break;
        }
      }
      if (!shouldOptimize) {
        return false;
      }
      // This compacts projection fragments and extends indexes. It never prunes
      // the authoritative SQLite ledger.
      await this.table!.optimize({ cleanupOlderThan: new Date(0) });
      return true;
    });
  }

  async search(options: HybridMemorySearchOptions): Promise<HybridMemorySearchResult[]> {
    await this.ensureInitialized();
    const queryText = requiredText(options.queryText, "queryText");
    validateVector(options.vector, this.vectorDimensions);
    const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 6)));
    const overfetch = Math.min(200, Math.max(limit, Math.floor(options.overfetch ?? limit * 5)));
    const filter = buildFilter(options);
    const columns = [
      "id",
      "recordType",
      "text",
      "vector",
      "agentId",
      "scope",
      "sessionKey",
      "channel",
      "conversationId",
      "factKey",
      "category",
      "status",
      "importance",
      "confidence",
      "authority",
      "validFrom",
      "validTo",
      "observedAt",
      "sourceEventId",
      "tagsJson",
      "updatedAt",
    ];
    const densePromise = this.table!.vectorSearch(options.vector)
      .distanceType("cosine")
      .refineFactor(3)
      .where(filter)
      .select([...columns, "_distance"])
      .limit(overfetch)
      .toArray()
      .then((rows) =>
        rows.map((row, index) => ({
          entry: rowToProjection(row),
          rank: index + 1,
          rawScore: 1 - Number(row["_distance"] ?? 1),
        })),
      );
    const lexicalPromise: Promise<SearchCandidate[]> = this.ftsReady
      ? this.table!.query()
          .fullTextSearch(queryText, { columns: "text" })
          .where(filter)
          .select([...columns, "_score"])
          .limit(overfetch)
          .toArray()
          .then((rows) =>
            rows.map((row, index) => ({
              entry: rowToProjection(row),
              rank: index + 1,
              rawScore: Number(row["_score"] ?? 0),
            })),
          )
      : Promise.resolve([]);
    const [dense, lexical] = await Promise.all([densePromise, lexicalPromise]);
    return deduplicateHybridResults(
      reciprocalRankFuse({ dense, lexical, limit: overfetch }),
      limit,
    );
  }

  async getStats(): Promise<HybridMemoryIndexStats> {
    await this.ensureInitialized();
    const indices = await this.table!.listIndices();
    return {
      rows: await this.table!.countRows(),
      indices: await Promise.all(
        indices.map(async (index) => {
          const stats = await this.table!.indexStats(index.name);
          return {
            name: index.name,
            columns: index.columns,
            type: stats?.indexType,
            indexedRows: stats?.numIndexedRows,
            unindexedRows: stats?.numUnindexedRows,
          };
        }),
      ),
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closing = true;
    this.closed = true;
    this.table?.close();
    this.db?.close();
    this.table = null;
    this.db = null;
    this.module = null;
    this.initPromise = null;
    this.ftsReady = false;
  }

  async closeAsync(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closing = true;
    const errors: unknown[] = [];
    try {
      await this.initPromise?.catch((error: unknown) => {
        errors.push(error);
      });
      await this.writeTail.catch((error: unknown) => {
        errors.push(error);
      });
    } finally {
      try {
        this.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "MEMORY_INDEX_CLOSE_FAILED");
    }
  }
}
