import { watch as watchFile } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import path from "node:path";

export const CHILD_DISPATCH_PROTOCOL_VERSION = 1 as const;
export const CHILD_DISPATCH_PROTOCOL_TIMEOUT_MS = 10_000;

export function requireChildDispatchProtocolPath(): string {
  const protocolPath = process.env.CHILD_DISPATCH_PROTOCOL;
  if (!protocolPath) {
    throw new Error("CHILD_DISPATCH_PROTOCOL is required");
  }
  return protocolPath;
}

export type ChildDispatchProtocolRecord =
  | {
      version: typeof CHILD_DISPATCH_PROTOCOL_VERSION;
      kind: "event";
      id: string;
      point: string;
      payload: Record<string, unknown>;
    }
  | {
      version: typeof CHILD_DISPATCH_PROTOCOL_VERSION;
      kind: "command";
      id: string;
      action: "allow" | "deny" | "close";
      payload?: Record<string, unknown>;
    };

function parseRecord(line: string): ChildDispatchProtocolRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<ChildDispatchProtocolRecord>;
    if (
      value.version !== CHILD_DISPATCH_PROTOCOL_VERSION ||
      typeof value.id !== "string" ||
      (value.kind !== "event" && value.kind !== "command")
    ) {
      return undefined;
    }
    if (value.kind === "event" && typeof value.point === "string") {
      return value as ChildDispatchProtocolRecord;
    }
    if (
      value.kind === "command" &&
      (value.action === "allow" || value.action === "deny" || value.action === "close")
    ) {
      return value as ChildDispatchProtocolRecord;
    }
  } catch {
    // A partial writer line is ignored until the next watch notification.
  }
  return undefined;
}

async function appendRecord(pathname: string, record: ChildDispatchProtocolRecord): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  const handle = await open(pathname, "a");
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function readRecords(pathname: string, offset: number) {
  const handle = await open(pathname, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) {
      return { records: [] as ChildDispatchProtocolRecord[], offset };
    }
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const records = buffer
      .toString("utf8")
      .split("\n")
      .map(parseRecord)
      .filter((record): record is ChildDispatchProtocolRecord => record !== undefined);
    return { records, offset: size };
  } finally {
    await handle.close();
  }
}

export async function ensureChildDispatchProtocolFile(pathname: string): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  const handle = await open(pathname, "a");
  await handle.close();
}

export async function emitChildDispatchProtocolEvent(params: {
  path: string;
  id: string;
  point: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await appendRecord(params.path, {
    version: CHILD_DISPATCH_PROTOCOL_VERSION,
    kind: "event",
    id: params.id,
    point: params.point,
    payload: params.payload ?? {},
  });
}

export async function awaitChildDispatchProtocolCommand(params: {
  path: string;
  id: string;
  timeoutMs?: number;
}): Promise<"allow" | "deny" | "close"> {
  await ensureChildDispatchProtocolFile(params.path);
  let offset = 0;
  const initial = await readRecords(params.path, offset);
  const alreadyWritten = initial.records.find(
    (record) => record.kind === "command" && record.id === params.id,
  );
  if (alreadyWritten?.kind === "command") {
    return alreadyWritten.action;
  }
  offset = initial.offset;
  return await waitForProtocolRecord({
    path: params.path,
    offset,
    timeoutMs: params.timeoutMs,
    description: `child dispatch barrier ${params.id}`,
    predicate: (record): record is Extract<ChildDispatchProtocolRecord, { kind: "command" }> =>
      record.kind === "command" && record.id === params.id,
  }).then((record) => record.action);
}

export async function releaseChildDispatchProtocolBarrier(params: {
  path: string;
  id: string;
  action?: "allow" | "deny" | "close";
  payload?: Record<string, unknown>;
}): Promise<void> {
  await appendRecord(params.path, {
    version: CHILD_DISPATCH_PROTOCOL_VERSION,
    kind: "command",
    id: params.id,
    action: params.action ?? "allow",
    ...(params.payload ? { payload: params.payload } : {}),
  });
}

export async function waitForChildDispatchProtocolEvent(params: {
  path: string;
  predicate: (record: Extract<ChildDispatchProtocolRecord, { kind: "event" }>) => boolean;
  timeoutMs?: number;
}): Promise<Extract<ChildDispatchProtocolRecord, { kind: "event" }>> {
  await ensureChildDispatchProtocolFile(params.path);
  let offset = 0;
  const initial = await readRecords(params.path, offset);
  offset = initial.offset;
  const first = initial.records.find(
    (record): record is Extract<ChildDispatchProtocolRecord, { kind: "event" }> =>
      record.kind === "event" && params.predicate(record),
  );
  if (first) {
    return first;
  }
  return await waitForProtocolRecord({
    path: params.path,
    offset,
    timeoutMs: params.timeoutMs,
    description: "child dispatch protocol event",
    predicate: (record): record is Extract<ChildDispatchProtocolRecord, { kind: "event" }> =>
      record.kind === "event" && params.predicate(record),
  });
}

async function waitForProtocolRecord<T extends ChildDispatchProtocolRecord>(params: {
  path: string;
  offset: number;
  timeoutMs?: number;
  description: string;
  predicate: (record: ChildDispatchProtocolRecord) => record is T;
}): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let offset = params.offset;
    let scanning = false;
    let scanAgain = false;
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error(`${params.description} timed out`)),
      params.timeoutMs ?? CHILD_DISPATCH_PROTOCOL_TIMEOUT_MS,
    );
    const watcher = watchFile(params.path, () => {
      void scan();
    });

    const finish = (error?: Error, value?: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error) {
        reject(error);
      } else if (value) {
        resolve(value);
      } else {
        reject(new Error(`${params.description} ended without a record`));
      }
    };

    const scan = async (): Promise<void> => {
      if (settled) {
        return;
      }
      if (scanning) {
        scanAgain = true;
        return;
      }
      scanning = true;
      try {
        const next = await readRecords(params.path, offset);
        offset = next.offset;
        const found = next.records.find(params.predicate);
        if (found) {
          finish(undefined, found);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        scanning = false;
        if (scanAgain) {
          scanAgain = false;
          void scan();
        }
      }
    };

    void scan();
  });
}
