import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  cleanupWorkerTurnLauncherTest,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerMediaAliasProjector, prepareWorkerTurnMedia } from "./worker-turn-media.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const projections = [
  {
    id: "GW-TAIL-R4-01-C01",
    aliases: [
      ["/tmp/a", "/remote/a"],
      ["/tmp/a2", "/remote/a2"],
    ],
    texts: ["/tmp/a2"],
    expected: ["/remote/a2"],
  },
  {
    id: "GW-TAIL-R4-01-C02",
    aliases: [
      ["/tmp/a2", "/remote/a2"],
      ["/tmp/a", "/remote/a"],
    ],
    texts: ["/tmp/a2"],
    expected: ["/remote/a2"],
  },
  {
    id: "GW-TAIL-R4-01-C03",
    aliases: [
      ["/tmp/a", "/remote/a"],
      ["/tmp/a2", "/remote/a2"],
    ],
    texts: ["current /tmp/a", "replay /tmp/a2"],
    expected: ["current /remote/a", "replay /remote/a2"],
  },
  {
    id: "GW-TAIL-R4-01-C04",
    aliases: [
      ["/tmp/a", "/tmp/a2/projected"],
      ["/tmp/a2", "/remote/b"],
    ],
    texts: ["current /tmp/a and /tmp/a2", "replay /tmp/a2 then /tmp/a"],
    expected: [
      "current /tmp/a2/projected and /remote/b",
      "replay /remote/b then /tmp/a2/projected",
    ],
  },
  {
    id: "GW-TAIL-R4-01-C05",
    aliases: [
      ["/workspace/data/file", "/remote/file"],
      ["/workspace/data/file2", "/remote/file2"],
    ],
    texts: ["/workspace/data/file2"],
    expected: ["/remote/file2"],
  },
  {
    id: "GW-TAIL-R4-01-C06",
    aliases: [["/tmp/a", "/remote/a"]],
    texts: ['(/tmp/a) and [/tmp/a], "/tmp/a"; --file=/tmp/a'],
    expected: ['(/remote/a) and [/remote/a], "/remote/a"; --file=/remote/a'],
  },
  {
    id: "GW-TAIL-R4-01-C07",
    aliases: [["/tmp/a", "/remote/a"]],
    texts: ["prose /tmp/aesthetic and x/tmp/a2 stay unchanged"],
    expected: ["prose /tmp/aesthetic and x/tmp/a2 stay unchanged"],
  },
  {
    id: "GW-TAIL-R4-01-C08",
    aliases: [
      ["/tmp/a", "/remote/a"],
      ["/tmp/b", "/remote/b"],
    ],
    texts: ["inspect /tmp/a and /tmp/b"],
    expected: ["inspect /remote/a and /remote/b"],
  },
  {
    id: "GW-TAIL-R4-01-C09",
    aliases: [
      ["/tmp/a", "/remote/a"],
      ["/tmp/a", "/remote/a"],
    ],
    texts: ["/tmp/a /tmp/a"],
    expected: ["/remote/a /remote/a"],
  },
] satisfies Array<{ id: string; aliases: string[][]; texts: string[]; expected: string[] }>;

describe("worker media alias projection — ten-case checkpoint pack", () => {
  beforeAll(setupWorkerTurnLauncherTest);
  afterAll(cleanupWorkerTurnLauncherTest);
  it.each(projections)("$id", ({ aliases, texts, expected }) => {
    const project = createWorkerMediaAliasProjector(new Map(aliases as Array<[string, string]>));
    expect(texts.map(project)).toEqual(expected);
  });

  it("GW-TAIL-R4-01-C10 stages both real prefix-overlap files and projects the correct paths", async () => {
    const localWorkspaceDir = tempDirs.make("worker-media-overlap-");
    const first = path.join(localWorkspaceDir, "a");
    const second = path.join(localWorkspaceDir, "a2");
    await fs.writeFile(first, "first-file");
    await fs.writeFile(second, "second-file");
    const staged = new Map<string, string>();
    const tunnel = {
      stageAttachments: async (request: { localPath: string }) => {
        for (const entry of await fs.readdir(request.localPath, { recursive: true })) {
          const source = path.join(request.localPath, entry);
          if ((await fs.stat(source)).isFile()) {
            staged.set(entry, await fs.readFile(source, "utf8"));
          }
        }
      },
    } as unknown as WorkerTunnelHandle;
    const prepared = await prepareWorkerTurnMedia({
      turn: {
        ...turn("media-prefix-overlap"),
        prompt: "Read " + second + " and " + first,
        media: [
          { path: first, contentType: "text/plain" },
          { path: second, contentType: "text/plain" },
        ],
      },
      history: [],
      localWorkspaceDir,
      remoteWorkspaceDir: "/worker/workspace",
      tunnel,
      isAuthorized: () => true,
      signal: new AbortController().signal,
    });
    const firstPath = [...staged].find(([, bytes]) => bytes === "first-file")?.[0];
    const secondPath = [...staged].find(([, bytes]) => bytes === "second-file")?.[0];
    expect(firstPath).toBeDefined();
    expect(secondPath).toBeDefined();
    expect(prepared.prompt).toBe(
      "Read " +
        path.posix.join("/worker/workspace", secondPath!) +
        " and " +
        path.posix.join("/worker/workspace", firstPath!),
    );
    expect(await fs.readFile(first, "utf8")).toBe("first-file");
    expect(await fs.readFile(second, "utf8")).toBe("second-file");
  });
});
