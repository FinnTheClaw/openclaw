import { Buffer } from "node:buffer";

type Entry<T> = { value: T; createdAt: number; bytes: number; expiresAt?: number };

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
  return Buffer.byteLength(serialized ?? String(value));
}

/** Bounded process-memory evidence cache. Raw message/tool content never enters plugin SQLite state. */
export class FunctionalFinnTransientStore<T> {
  private readonly values = new Map<string, Entry<T>>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
    private readonly sizeOf: (value: T) => number = serializedBytes,
  ) {}

  private remove(key: string): boolean {
    const entry = this.values.get(key);
    if (!entry) {
      return false;
    }
    this.totalBytes -= entry.bytes;
    this.values.delete(key);
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.remove(key);
      }
    }
  }

  registerIfAbsent(key: string, value: T, options?: { ttlMs?: number }): boolean {
    this.sweep();
    if (this.values.has(key)) {
      return false;
    }
    const bytes = Buffer.byteLength(key) + this.sizeOf(value);
    if (bytes > this.maxBytes) {
      return false;
    }
    while (this.values.size >= this.maxEntries || this.totalBytes + bytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.remove(oldest);
    }
    const createdAt = this.now();
    this.values.set(key, {
      value,
      createdAt,
      bytes,
      ...(options?.ttlMs ? { expiresAt: createdAt + options.ttlMs } : {}),
    });
    this.totalBytes += bytes;
    return true;
  }

  lookup(key: string): T | undefined {
    this.sweep();
    return this.values.get(key)?.value;
  }

  entries(): Array<{ key: string; value: T }> {
    this.sweep();
    return [...this.values].map(([key, entry]) => ({ key, value: entry.value }));
  }

  delete(key: string): boolean {
    return this.remove(key);
  }
}
