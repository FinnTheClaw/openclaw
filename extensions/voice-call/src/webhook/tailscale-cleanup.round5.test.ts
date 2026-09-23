// Round-five L4-03: ten targeted Tailscale cleanup assertions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandWithTimeout: runMock }));

import {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  setupTailscaleExposureRoutes,
} from "./tailscale.js";

const result = (overrides: Record<string, unknown> = {}) => ({
  stdout: "",
  stderr: "",
  code: 0,
  termination: "exit",
  ...overrides,
});
const route = { mode: "serve" as const, port: 443, path: "/voice" };
const config = {
  tailscale: { mode: "serve", port: 443, path: "/voice" },
  serve: { port: 8787, path: "/webhook" },
  realtime: { enabled: false },
  streaming: { enabled: false },
};
const dns = result({ stdout: JSON.stringify({ Self: { DNSName: "bot.ts.net." } }) });

describe("round-five L4-03 Tailscale cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockResolvedValue(result());
  });

  it("01 reports a nonzero off exit with route identity", async () => {
    runMock.mockResolvedValue(result({ code: 7 }));
    await expect(cleanupTailscaleExposureRoute(route)).rejects.toThrow(
      "Tailscale serve off failed for /voice on HTTPS 443 (exit 7)",
    );
  });

  it("02 reports a timed-out off command", async () => {
    runMock.mockResolvedValue(result({ termination: "timeout", code: null }));
    await expect(cleanupTailscaleExposureRoute(route)).rejects.toThrow("(exit -1)");
  });

  it("03 reports an unavailable tailscale executable", async () => {
    runMock.mockRejectedValue(new Error("ENOENT"));
    await expect(cleanupTailscaleExposureRoute(route)).rejects.toThrow("(exit -1)");
  });

  it("04 uses the selected HTTPS port in a failed off command", async () => {
    runMock.mockResolvedValue(result({ code: 2 }));
    await expect(cleanupTailscaleExposureRoute({ ...route, port: 8443 })).rejects.toThrow(
      "HTTPS 8443 (exit 2)",
    );
    expect(runMock.mock.calls[0]?.[0]).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--yes",
      "--https",
      "8443",
      "--set-path",
      "/voice",
      "off",
    ]);
  });

  it("05 attempts stream cleanup after webhook cleanup fails", async () => {
    runMock.mockResolvedValueOnce(result({ code: 1 })).mockResolvedValueOnce(result());
    const withStream = {
      ...config,
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
    } as never;
    await expect(cleanupTailscaleExposure(withStream)).rejects.toThrow("cleanup incomplete");
    expect(runMock.mock.calls.map(([cmd]) => cmd[cmd.length - 1])).toEqual([
      "/voice",
      "/voice/stream/realtime",
    ]);
  });

  it("06 aggregates failures from both cleanup routes", async () => {
    runMock.mockResolvedValue(result({ code: 3 }));
    const withStream = {
      ...config,
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
    } as never;
    await expect(cleanupTailscaleExposure(withStream)).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("07 exposes an incomplete rollback instead of claiming success", async () => {
    runMock
      .mockResolvedValueOnce(dns)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 4 }))
      .mockResolvedValueOnce(result({ code: 5 }));
    await expect(
      setupTailscaleExposureRoutes({
        mode: "serve",
        port: 443,
        routes: [
          { path: "/voice", localUrl: "http://127.0.0.1:8787/a" },
          { path: "/stream", localUrl: "http://127.0.0.1:8787/b" },
        ],
      }),
    ).rejects.toThrow("rollback incomplete");
  });

  it("08 keeps rolling back other mounted routes after one off fails", async () => {
    runMock
      .mockResolvedValueOnce(dns)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 4 }))
      .mockResolvedValueOnce(result({ code: 5 }))
      .mockResolvedValueOnce(result());
    await expect(
      setupTailscaleExposureRoutes({
        mode: "serve",
        port: 443,
        routes: [
          { path: "/a", localUrl: "http://127.0.0.1:8787/a" },
          { path: "/b", localUrl: "http://127.0.0.1:8787/b" },
          { path: "/c", localUrl: "http://127.0.0.1:8787/c" },
        ],
      }),
    ).rejects.toThrow("rollback incomplete");
    expect(runMock.mock.calls.slice(4).map(([cmd]) => cmd[3])).toEqual(["/b", "/a"]);
  });

  it("09 returns null after a complete rollback", async () => {
    runMock
      .mockResolvedValueOnce(dns)
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 4 }))
      .mockResolvedValueOnce(result());
    await expect(
      setupTailscaleExposureRoutes({
        mode: "serve",
        port: 443,
        routes: [
          { path: "/a", localUrl: "http://127.0.0.1:8787/a" },
          { path: "/b", localUrl: "http://127.0.0.1:8787/b" },
        ],
      }),
    ).resolves.toBeNull();
    expect(runMock.mock.calls[3]?.[0]).toEqual(["tailscale", "serve", "off", "/a"]);
  });

  it("10 performs no cleanup in off configuration", async () => {
    await expect(
      cleanupTailscaleExposure({
        ...config,
        tailscale: { mode: "off", port: 443, path: "/voice" },
      } as never),
    ).resolves.toBeUndefined();
    expect(runMock).not.toHaveBeenCalled();
  });
});
