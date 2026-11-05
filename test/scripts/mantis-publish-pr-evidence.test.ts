// Mantis Publish Pr Evidence tests cover mantis publish pr evidence script behavior.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadEvidenceManifest,
  publishArtifactFiles,
  publishEvidence,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";

const commandMocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(() => {
    throw new Error("Unexpected Mantis command");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: commandMocks.execFileSync,
}));

const tempDirs: string[] = [];

afterEach(() => {
  commandMocks.execFileSync.mockReset().mockImplementation(() => {
    throw new Error("Unexpected Mantis command");
  });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixtureManifest() {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "baseline"), { recursive: true });
  mkdirSync(path.join(dir, "candidate"), { recursive: true });
  writeFileSync(path.join(dir, "baseline", "timeline.png"), "baseline timeline");
  writeFileSync(path.join(dir, "candidate", "timeline.png"), "candidate timeline");
  writeFileSync(path.join(dir, "baseline", "change.mp4"), "baseline clip");
  const manifestPath = path.join(dir, "mantis-evidence.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      id: "discord-status-reactions",
      title: "Mantis Discord Status Reactions QA",
      summary: "Mantis reran the scenario.",
      scenario: "discord-status-reactions-tool-only",
      comparison: {
        baseline: {
          expected: "queued-only",
          expectationMet: true,
          sha: "aaa",
          status: "fail",
        },
        candidate: {
          expected: "queued -> thinking -> done",
          expectationMet: true,
          sha: "bbb",
          status: "pass",
        },
        pass: true,
      },
      artifacts: [
        {
          alt: "Baseline timeline",
          kind: "timeline",
          label: "Baseline queued-only",
          lane: "baseline",
          path: "baseline/timeline.png",
          targetPath: "baseline.png",
        },
        {
          alt: "Candidate timeline",
          kind: "timeline",
          label: "Candidate queued -> thinking -> done",
          lane: "candidate",
          path: "candidate/timeline.png",
          targetPath: "candidate.png",
        },
        {
          kind: "motionClip",
          label: "Baseline change MP4",
          lane: "baseline",
          path: "baseline/change.mp4",
          targetPath: "baseline-change.mp4",
        },
      ],
    }),
  );
  return manifestPath;
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
    const manifestPath = writeFixtureManifest();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.comparison.candidate.expectationMet;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(
      "Mantis evidence comparison.candidate.expectationMet must be a boolean.",
    );
  });

  it("renders a manifest-driven PR comment with inline screenshots and video links", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const body = renderEvidenceComment({
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-discord-status-reactions -->",
      rawBase: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
    });

    expect(body).toContain("<!-- mantis-discord-status-reactions -->");
    expect(body).toContain("Summary: Mantis reran the scenario.");
    expect(body).toContain('<table width="100%">');
    expect(body).toContain('<th width="50%">Baseline queued-only</th>');
    expect(body).toContain('<th width="50%">Candidate queued -> thinking -> done</th>');
    expect(body).toContain(
      '<td width="50%" align="center"><img src="https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png" width="100%"',
    );
    expect(body).toContain(
      "[Baseline change MP4](https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline-change.mp4)",
    );
    expect(body).not.toContain("raw.githubusercontent.com");
    expect(body).toContain("- Overall: `pass`");
  });

  it("renders trusted lane digests and their count differential", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    manifest.comparison = {
      baseline: {
        digest:
          "2 sent · 2 bot messages · 1 edit · 1 delete · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
        expected: "baseline behavior",
        expectationMet: true,
        sha: "aaa",
        status: "pass",
      },
      candidate: {
        digest:
          "2 sent · 3 bot messages · 1 edit · 0 deletes · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
        expected: "candidate behavior",
        expectationMet: true,
        sha: "bbb",
        status: "pass",
      },
      differential: "bot messages 2→3 · deletes 1→0",
      outcome: "pass",
      pass: true,
    };

    const body = renderEvidenceComment({
      manifest,
      marker: "<!-- mantis-discord-status-reactions -->",
      rawBase: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
    });

    expect(body).toContain(
      "- Baseline: `pass` at `aaa` — baseline behavior · facts: 2 sent · 2 bot messages · 1 edit · 1 delete · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
    );
    expect(body).toContain(
      "- Candidate (PR merged onto main): `pass` at `bbb` — candidate behavior · facts: 2 sent · 3 bot messages · 1 edit · 0 deletes · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
    );
    expect(body).toContain(
      "- Differential (trusted facts): bot messages 2→3 · deletes 1→0\n- Overall: `pass`",
    );
  });

  it("uploads manifest artifacts to R2-compatible object storage", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const requests: Array<{
      body: Buffer;
      headers: HeadersInit;
      method: string;
      signal: AbortSignal;
      url: string;
    }> = [];
    const fetchImpl = async (
      url: URL,
      init: { body: Buffer; headers: HeadersInit; method: string; signal: AbortSignal },
    ) => {
      requests.push({
        body: init.body,
        headers: init.headers,
        method: init.method,
        signal: init.signal,
        url: url.toString(),
      });
      return new Response("", { status: 200 });
    };

    const published = await publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl,
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
    });

    expect(published).toEqual({
      artifactRoot: "mantis/discord/pr-1/run-1",
      rawBase: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
      treeUrl: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/index.json",
    });
    expect(requests.map((request) => request.method)).toEqual(["PUT", "PUT", "PUT", "PUT", "PUT"]);
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/baseline.png",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/candidate.png",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/baseline-change.mp4",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/mantis-evidence.json",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/index.json",
    ]);
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-date": expect.any(String),
    });
    expect((requests[0]?.headers as Record<string, string> | undefined)?.authorization).toContain(
      "Credential=access/",
    );
    expect(String(requests[4]?.body)).toContain(
      '"url": "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png"',
    );
  });

  it("aborts a stalled artifact upload after the per-object timeout", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    let observedSignal: AbortSignal | undefined;

    const upload = publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl: (_url, init) => {
        observedSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), {
            once: true,
          });
        });
      },
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
      timeoutMs: 5,
    });

    await expect(upload).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
      message: "Timed out uploading Mantis artifact baseline.png after 5ms.",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds oversized non-ok upload error response bodies", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const chunk = new Uint8Array(8 * 1024).fill("x".charCodeAt(0));
    let enqueuedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueuedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const upload = publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl: async () =>
        new Response(body, {
          status: 503,
          statusText: "Service Unavailable",
        }),
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
    });

    await expect(upload).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 503 Service Unavailable\nMantis upload error response body exceeded 65536 bytes$/u,
      ),
    });
    // Unbounded response.text() would keep pulling forever; the bound cancels after ~64 KiB.
    expect(enqueuedBytes).toBeGreaterThan(64 * 1024);
    expect(enqueuedBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("propagates signal abort during non-ok upload error body reading", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    let cancelled = false;
    // A slow-streaming error body that will stall until the signal fires.
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Never resolves; the signal will abort the read.
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    const upload = publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl: async () =>
        new Response(body, {
          status: 503,
          statusText: "Service Unavailable",
        }),
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
      timeoutMs: 50,
    });

    await expect(upload).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
      message: "Timed out uploading Mantis artifact baseline.png after 50ms.",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cancelled).toBe(true);
  });

  it("reads small non-ok upload error response bodies within the bound", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const smallBody = "access denied: invalid credentials";

    const upload = publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl: async () =>
        new Response(smallBody, {
          status: 403,
          statusText: "Forbidden",
        }),
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
    });

    await expect(upload).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 403 Forbidden\naccess denied: invalid credentials$/u,
      ),
    });
  });

  it("allows failure manifests to omit optional visual artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ status: "fail" }));
    writeFileSync(path.join(dir, "report.md"), "bootstrap failed before screenshot");
    const manifestPath = path.join(dir, "mantis-evidence.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: "slack-desktop-smoke",
        title: "Mantis Slack Desktop Smoke QA",
        summary: "Mantis could not finish VM setup.",
        scenario: "slack-openclaw-desktop-smoke",
        comparison: {
          candidate: {
            expected: "Slack QA and VM gateway setup pass",
            expectationMet: false,
            sha: "bbb",
            status: "fail",
          },
          pass: false,
        },
        artifacts: [
          {
            alt: "Slack Web desktop screenshot from the Mantis VM",
            inline: true,
            kind: "desktopScreenshot",
            label: "Slack desktop/VNC browser",
            lane: "candidate",
            path: "slack-desktop-smoke.png",
            required: false,
            targetPath: "slack-desktop.png",
          },
          {
            kind: "metadata",
            label: "Slack desktop summary",
            lane: "run",
            path: "summary.json",
            targetPath: "summary.json",
          },
          {
            kind: "report",
            label: "Slack desktop report",
            lane: "run",
            path: "report.md",
            targetPath: "report.md",
          },
        ],
      }),
    );

    const manifest = loadEvidenceManifest(manifestPath);
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "summary.json",
      "report.md",
      "mantis-evidence.json",
    ]);
    const body = renderEvidenceComment({
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-slack-desktop-smoke -->",
      rawBase: "https://qa.openclaw.ai/mantis/slack/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://qa.openclaw.ai/mantis/slack/pr-1/run-1",
    });

    expect(body).toContain("Summary: Mantis could not finish VM setup.");
    expect(body).toContain("- Overall: `fail`");
    expect(body).not.toContain("<img ");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, "mantis-evidence.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifacts: [
          {
            kind: "metadata",
            path: "../outside.json",
          },
        ],
        comparison: {
          candidate: { expected: "artifact path is contained", expectationMet: true },
          pass: true,
        },
        id: "bad",
        scenario: "bad",
        schemaVersion: 2,
        title: "Bad",
      }),
    );

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(/escapes manifest directory/u);
  });
});
