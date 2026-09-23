import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderArtifactsSummary, renderAttendanceSummary } from "./cli-export.js";
import { captureStdout, setupCli, stubMeetArtifactsApi } from "./test-support/cli-harness.js";

const options = [
  "--access-token",
  "token",
  "--expires-at",
  String(Date.now() + 3_600_000),
  "--conference-record",
  "rec-1",
];

async function run(command: "artifacts" | "attendance", extra: string[] = []) {
  const stdout = captureStdout();
  try {
    await setupCli({}).parseAsync(["googlemeet", command, ...options, ...extra], { from: "user" });
    return stdout.output();
  } finally {
    stdout.restore();
  }
}

describe("round-seven Google Meet summary output", () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function outputPath(name: string) {
    dir = mkdtempSync(path.join(tmpdir(), "meet-round7-"));
    return path.join(dir, name);
  }

  it("GM01 writes artifacts summary and token source to --output", async () => {
    stubMeetArtifactsApi();
    const file = outputPath("artifacts.txt");
    const stdout = await run("artifacts", ["--output", file]);
    expect(readFileSync(file, "utf8")).toContain("conference records:");
    expect(readFileSync(file, "utf8")).toContain("token source: cached-access-token");
    expect(stdout).toBe(`wrote: ${file}\n`);
  });

  it("GM02 writes attendance summary and token source to --output", async () => {
    stubMeetArtifactsApi();
    const file = outputPath("attendance.txt");
    const stdout = await run("attendance", ["--output", file]);
    expect(readFileSync(file, "utf8")).toContain("attendance rows: 1");
    expect(readFileSync(file, "utf8")).toContain("token source: cached-access-token");
    expect(stdout).toBe(`wrote: ${file}\n`);
  });

  it("GM03 retains artifacts summary stdout without --output", async () => {
    stubMeetArtifactsApi();
    expect(await run("artifacts")).toContain("record: conferenceRecords/rec-1");
  });

  it("GM04 retains attendance summary stdout without --output", async () => {
    stubMeetArtifactsApi();
    expect(await run("attendance")).toContain("participant: Alice");
  });

  it("GM05 renders empty artifacts as a zero-count summary", () => {
    const text = renderArtifactsSummary({ conferenceRecords: [], artifacts: [] } as never);
    expect(text).toBe("conference records: 0\n");
  });

  it("GM06 renders empty attendance as a zero-count summary", () => {
    const text = renderAttendanceSummary({ conferenceRecords: [], attendance: [] } as never);
    expect(text).toBe("conference records: 0\nattendance rows: 0\n");
  });

  it("GM07 replaces an existing output file and preserves its mode", async () => {
    stubMeetArtifactsApi();
    const file = outputPath("existing.txt");
    writeFileSync(file, "old", "utf8");
    chmodSync(file, 0o640);
    await run("artifacts", ["--output", file]);
    expect(readFileSync(file, "utf8")).not.toContain("old");
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("GM08 rejects a missing output parent without leaving a partial file", async () => {
    stubMeetArtifactsApi();
    const file = path.join(outputPath("unused"), "missing", "out.txt");
    await expect(run("artifacts", ["--output", file])).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it("GM09 preserves markdown and JSON artifact --output behavior", async () => {
    stubMeetArtifactsApi();
    const markdown = outputPath("artifacts.md");
    await run("artifacts", ["--format", "markdown", "--output", markdown]);
    expect(readFileSync(markdown, "utf8")).toContain("# Google Meet Artifacts");
    const json = path.join(dir, "artifacts.json");
    await run("artifacts", ["--json", "--output", json]);
    expect(JSON.parse(readFileSync(json, "utf8")).artifacts).toBeDefined();
  });

  it("GM10 preserves CSV and JSON attendance --output behavior", async () => {
    stubMeetArtifactsApi();
    const csv = outputPath("attendance.csv");
    await run("attendance", ["--format", "csv", "--output", csv]);
    expect(readFileSync(csv, "utf8")).toContain("Alice");
    const json = path.join(dir, "attendance.json");
    await run("attendance", ["--json", "--output", json]);
    expect(JSON.parse(readFileSync(json, "utf8")).attendance).toBeDefined();
  });
});
