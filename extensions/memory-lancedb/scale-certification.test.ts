import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemoryScaleCertification } from "./scale-certification.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("memory scale certification", () => {
  it("keeps a thousand facts durable and returns bounded rank-one recall", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-cert-test-"));
    directories.push(directory);
    const report = await runMemoryScaleCertification({
      facts: 1_000,
      queries: 20,
      directory,
      keep: true,
    });

    expect(report.status).toBe("PASS");
    expect(report.recallAt1).toBe(1);
    expect(report.ledgerStats.events).toBe(1_000);
    expect(report.reopenStats.events).toBe(1_000);
    expect(report.indexStats.rows).toBe(1_000);
    expect(report.fullyIndexed).toBe(true);
    await expect(fs.stat(report.snapshotPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });
});
