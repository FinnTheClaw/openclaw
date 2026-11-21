import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadEvidenceManifest,
  publishArtifactFiles,
  publishEvidence,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const commandMocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(() => {
    throw new Error("Unexpected Mantis command");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: commandMocks.execFileSync,
}));

afterEach(() => {
  commandMocks.execFileSync.mockReset().mockImplementation(() => {
    throw new Error("Unexpected Mantis command");
  });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const storageConfig = {
  accessKeyId: "access",
  bucket: "qa-artifacts",
  endpoint: "https://example.r2.cloudflarestorage.com",
  publicBaseUrl: "https://qa.openclaw.ai",
  region: "auto",
  secretAccessKey: "secret",
};
const artifactRoot = "mantis/discord/pr-1/run-1";
const rawBase = `https://qa.openclaw.ai/${artifactRoot}`;
const marker = "<!-- mantis-discord-status-reactions -->";
type ArtifactFetch = NonNullable<Parameters<typeof publishArtifactFiles>[0]["fetchImpl"]>;
function render(manifest: ReturnType<typeof loadEvidenceManifest>) {
  return renderEvidenceComment({ manifest, marker, rawBase });
}
function contains(body: string, ...parts: string[]) {
  for (const part of parts) {
    expect(body).toContain(part);
  }
}
function upload(fetchImpl: ArtifactFetch, timeoutMs?: number) {
  return publishArtifactFiles({
    artifactRoot,
    fetchImpl,
    storageConfig,
    timeoutMs,
    manifest: loadEvidenceManifest(writeFixtureManifest()),
  });
}
function writeManifest(manifest: object = {}, files: string[] = []) {
  const dir = tempDirs.make("mantis-evidence-test-");
  for (const name of files) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), name);
  }
  const file = path.join(dir, "mantis-evidence.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      id: "discord-status-reactions",
      title: "Mantis Discord Status Reactions QA",
      scenario: "discord-status-reactions-tool-only",
      comparison: { candidate: lane("artifact path is contained", "bbb", "pass"), pass: true },
      ...manifest,
    }),
  );
  return file;
}
function lane(expected: string, sha: string, status: string, expectationMet = true) {
  return { expected, sha, status, expectationMet };
}
function timeline(laneName: string) {
  return {
    kind: "timeline",
    lane: laneName,
    label: laneName,
    path: `${laneName}/timeline.png`,
    targetPath: `${laneName}.png`,
  };
}
const fixtureArtifacts = [
  timeline("baseline"),
  timeline("candidate"),
  {
    kind: "motionClip",
    path: "baseline/change.mp4",
    targetPath: "baseline-change.mp4",
    label: "Baseline change MP4",
  },
];
function writeFixtureManifest() {
  return writeManifest(
    {
      summary: "Mantis reran the scenario.",
      comparison: {
        baseline: lane("queued-only", "aaa", "fail"),
        candidate: { ...lane("queued -> thinking -> done", "bbb", "pass"), digest: "3 messages" },
        differential: "bot messages 2→3 · deletes 1→0",
        pass: true,
      },
      artifacts: fixtureArtifacts,
    },
    fixtureArtifacts.map(({ path: source }) => source),
  );
}

describe("scripts/mantis/publish-pr-evidence", () => {
  it.each([
    {
      name: "explicit repository creation",
      repositorySource: "argument",
      commentId: "",
      patchFails: false,
      createMissing: true,
      expectedCreate: true,
    },
    {
      name: "environment repository creation",
      repositorySource: "environment",
      commentId: "",
      patchFails: false,
      createMissing: true,
      expectedCreate: true,
    },
    {
      name: "creation after a selected-repository PATCH failure",
      repositorySource: "argument",
      commentId: "731",
      patchFails: true,
      createMissing: true,
      expectedCreate: true,
    },
    {
      name: "selected-repository PATCH success without creation",
      repositorySource: "argument",
      commentId: "731",
      patchFails: false,
      createMissing: true,
      expectedCreate: false,
    },
    {
      name: "creation disabled with no existing comment",
      repositorySource: "argument",
      commentId: "",
      patchFails: false,
      createMissing: false,
      expectedCreate: false,
    },
  ])(
    "L07-F30 keeps the selected repository for $name",
    async ({ repositorySource, commentId, patchFails, createMissing, expectedCreate }) => {
      const selectedRepo = "selected/evidence-repository";
      const ambientRepo = "ambient/checkout-repository";
      const prNumber = "42";
      const marker = "<!-- L07-F30 synthetic evidence -->";
      const artifactRoot = "mantis/l07-f30/pr-42/run-1";
      const endpoint = "https://storage.example.invalid";
      vi.stubEnv("GH_TOKEN", "synthetic-gh-token");
      vi.stubEnv("GITHUB_TOKEN", "");
      vi.stubEnv("GH_REPO", ambientRepo);
      vi.stubEnv(
        "GITHUB_REPOSITORY",
        repositorySource === "environment" ? selectedRepo : ambientRepo,
      );
      vi.stubEnv("MANTIS_ARTIFACT_R2_ACCESS_KEY_ID", "synthetic-access");
      vi.stubEnv("MANTIS_ARTIFACT_R2_SECRET_ACCESS_KEY", "synthetic-secret");
      vi.stubEnv("MANTIS_ARTIFACT_R2_BUCKET", "qa-artifacts");
      vi.stubEnv("MANTIS_ARTIFACT_R2_ENDPOINT", endpoint);
      vi.stubEnv("MANTIS_ARTIFACT_R2_PUBLIC_BASE_URL", "https://evidence.example.invalid");
      vi.stubEnv("MANTIS_ARTIFACT_R2_REGION", "auto");
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const uploads: Array<{ method: string | undefined; url: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL, init: RequestInit) => {
          uploads.push({ method: init.method, url: url.toString() });
          return new Response(null, { status: 200 });
        }),
      );
      const apiPaths: string[] = [];
      const patches: Array<{ bodyHasMarker: boolean; path: string }> = [];
      const creations: Array<{
        args: string[];
        bodyHasMarker: boolean;
        effectiveRepo: string | undefined;
      }> = [];
      commandMocks.execFileSync.mockImplementation((command, rawArgs) => {
        if (
          command !== "gh" ||
          !Array.isArray(rawArgs) ||
          !rawArgs.every((arg) => typeof arg === "string")
        ) {
          throw new Error("Unexpected Mantis command");
        }
        const args = rawArgs as string[];
        if (
          args.length === 4 &&
          args[0] === "api" &&
          args[1] === `repos/${selectedRepo}/pulls/${prNumber}` &&
          args[2] === "--jq" &&
          args[3] === ".number"
        ) {
          apiPaths.push(args[1]);
          return prNumber;
        }
        if (
          args.length === 5 &&
          args[0] === "api" &&
          args[1] === "--paginate" &&
          args[2] === `repos/${selectedRepo}/issues/${prNumber}/comments` &&
          args[3] === "--jq" &&
          args[4] ===
            `.[] | select(.user.login == "openclaw-mantis[bot]" and (.body | contains("${marker}"))) | .id`
        ) {
          apiPaths.push(args[2]);
          return commentId;
        }
        if (
          args.length === 6 &&
          args[0] === "api" &&
          args[1] === "--method" &&
          args[2] === "PATCH" &&
          args[3] === `repos/${selectedRepo}/issues/comments/${commentId}` &&
          args[4] === "--input"
        ) {
          const payload = JSON.parse(readFileSync(args[5], "utf8")) as { body: string };
          patches.push({ path: args[3], bodyHasMarker: payload.body.includes(marker) });
          if (patchFails) {
            throw new Error("synthetic PATCH failure");
          }
          return "";
        }
        const bodyFileIndex = args.indexOf("--body-file");
        if (
          args[0] === "pr" &&
          args[1] === "comment" &&
          args[2] === prNumber &&
          bodyFileIndex >= 3 &&
          bodyFileIndex === args.length - 2
        ) {
          const repoIndex = args.indexOf("--repo");
          creations.push({
            args: [...args],
            bodyHasMarker: readFileSync(args[bodyFileIndex + 1], "utf8").includes(marker),
            effectiveRepo: repoIndex === -1 ? process.env.GH_REPO : args[repoIndex + 1],
          });
          return "";
        }
        throw new Error(`Unexpected Mantis gh arguments: ${JSON.stringify(args)}`);
      });
      const args = [
        "--manifest",
        writeFixtureManifest(),
        "--target-pr",
        prNumber,
        "--artifact-root",
        artifactRoot,
        "--marker",
        marker,
        "--create-missing",
        String(createMissing),
        ...(repositorySource === "argument" ? ["--repo", selectedRepo] : []),
      ];
      let observedError: string | undefined;
      try {
        await publishEvidence(args);
      } catch (error) {
        observedError = String(error);
      }

      expect({ observedError, apiPaths, patches, creations, uploads }).toEqual({
        observedError: undefined,
        apiPaths: [
          `repos/${selectedRepo}/pulls/${prNumber}`,
          `repos/${selectedRepo}/issues/${prNumber}/comments`,
        ],
        patches: commentId
          ? [{ path: `repos/${selectedRepo}/issues/comments/${commentId}`, bodyHasMarker: true }]
          : [],
        creations: expectedCreate
          ? [
              {
                args: [
                  "pr",
                  "comment",
                  prNumber,
                  "--repo",
                  selectedRepo,
                  "--body-file",
                  expect.any(String),
                ],
                bodyHasMarker: true,
                effectiveRepo: selectedRepo,
              },
            ]
          : [],
        uploads: [
          "baseline.png",
          "candidate.png",
          "baseline-change.mp4",
          "mantis-evidence.json",
          "index.json",
        ].map((name) => ({
          method: "PUT",
          url: `${endpoint}/qa-artifacts/${artifactRoot}/${name}`,
        })),
      });
    },
  );

  it("selects only Mantis-owned status comments", () => {
    const source = readFileSync("scripts/mantis/publish-pr-evidence.mjs", "utf8");

    expect(source).toContain('.user.login == "openclaw-mantis[bot]"');
  });

  it("keeps required booleans for sibling trusted evidence producers", () => {
    const manifestPath = writeManifest({ comparison: { candidate: {}, pass: true } });
    expect(() => loadEvidenceManifest(manifestPath)).toThrow(
      "Mantis evidence comparison.candidate.expectationMet must be a boolean.",
    );
  });

  it("renders a manifest-driven PR comment with inline screenshots and video links", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const body = renderEvidenceComment({
      manifest,
      marker,
      rawBase,
      artifactUrl: "https://example.test/artifact",
      requestSource: "pull_request",
      runUrl: "https://example.test/run",
      treeUrl: "https://example.test/files",
    });
    contains(
      body,
      marker,
      "- Artifact: https://example.test/artifact",
      "- Trigger: `pull_request`",
      "- Run: https://example.test/run",
      "Raw QA files: https://example.test/files",
      "Summary: Mantis reran the scenario.",
      '<table width="100%">',
      '<th width="50%">baseline</th>',
      '<th width="50%">candidate</th>',
      `<td width="50%" align="center"><img src="${rawBase}/baseline.png" width="100%"`,
      `[Baseline change MP4](${rawBase}/baseline-change.mp4)`,
      "- Baseline: `fail` at `aaa`, expected queued-only",
      "- Candidate (PR merged onto main): `pass` at `bbb` — queued -&gt; thinking -&gt; done · facts: 3 messages",
      "- Differential (trusted facts): bot messages 2→3 · deletes 1→0\n- Overall: `pass`",
    );
    expect(body).not.toContain("raw.githubusercontent.com");
  });

  it("uploads manifest artifacts to R2-compatible object storage", async () => {
    const requests: Array<Parameters<ArtifactFetch>[1] & { url: string }> = [];
    const published = await upload(async (url, init) => {
      requests.push({ ...init, url: url.toString() });
      return new Response("", { status: 200 });
    });

    expect(published).toEqual({ artifactRoot, rawBase, treeUrl: `${rawBase}/index.json` });
    expect(requests.map(({ url }) => url)).toEqual(
      [
        ...fixtureArtifacts.map(({ targetPath }) => targetPath),
        "mantis-evidence.json",
        "index.json",
      ].map(
        (target) => `${storageConfig.endpoint}/${storageConfig.bucket}/${artifactRoot}/${target}`,
      ),
    );
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "PUT",
        signal: expect.any(AbortSignal),
      });
    }
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-date": expect.any(String),
    });
    expect(new Headers(requests[0]?.headers).get("authorization")).toContain("Credential=access/");
    expect(String(requests[4]?.body)).toContain(
      '"url": "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png"',
    );
  });

  it("aborts a stalled artifact upload after the per-object timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const pendingUpload = upload((_url, init) => {
      observedSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), {
          once: true,
        });
      });
    }, 5);

    await expect(pendingUpload).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
      message: "Timed out uploading Mantis artifact baseline.png after 5ms.",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds oversized non-ok upload error response bodies", async () => {
    const chunk = new Uint8Array(8 * 1024).fill("x".charCodeAt(0));
    let enqueuedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueuedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    await expect(
      upload(async () => new Response(body, { status: 503, statusText: "Service Unavailable" })),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 503 Service Unavailable\nMantis upload error response body exceeded 65536 bytes$/u,
      ),
    });
    expect(enqueuedBytes).toBeGreaterThan(64 * 1024);
    expect(enqueuedBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("propagates signal abort during non-ok upload error body reading", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(upload(async () => new Response(body, { status: 503 }), 50)).rejects.toMatchObject(
      {
        cause: { name: "TimeoutError" },
        message: "Timed out uploading Mantis artifact baseline.png after 50ms.",
      },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cancelled).toBe(true);
  });

  it("reads small non-ok upload error response bodies within the bound", async () => {
    await expect(
      upload(async () => new Response("access denied", { status: 403 })),
    ).rejects.toMatchObject({
      message: "Failed to upload Mantis artifact baseline.png: 403 \naccess denied",
    });
  });

  it("allows failure manifests to omit optional visual artifacts", () => {
    const manifest = loadEvidenceManifest(
      writeManifest({
        comparison: {
          candidate: lane("Slack QA and VM gateway setup pass", "bbb", "fail", false),
          pass: false,
        },
        artifacts: [
          { inline: true, kind: "desktopScreenshot", path: "missing.png", required: false },
        ],
      }),
    );
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "mantis-evidence.json",
    ]);
    const body = render(manifest);
    contains(body, "- Overall: `fail`");
    expect(body).not.toContain("<img ");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const manifestPath = writeManifest({
      artifacts: [{ kind: "metadata", path: "../outside.json" }],
    });

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(/escapes manifest directory/u);
  });
});
