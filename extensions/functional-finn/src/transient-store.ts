type Entry<T> = { value: T; createdAt: number; expiresAt?: number };

/** Bounded process-memory evidence cache. Raw message/tool content never enters plugin SQLite state. */
export class FunctionalFinnTransientStore<T> {
  private readonly values = new Map<string, Entry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.values.delete(key);
      }
    }
  }

  registerIfAbsent(key: string, value: T, options?: { ttlMs?: number }): boolean {
    this.sweep();
    if (this.values.has(key)) {
      return false;
    }
    while (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.values.delete(oldest);
    }
    const createdAt = this.now();
    this.values.set(key, {
      value,
      createdAt,
      ...(options?.ttlMs ? { expiresAt: createdAt + options.ttlMs } : {}),
    });
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
    return this.values.delete(key);
  }
}
