import { EventEmitter } from "node:events";
import net from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const ENTRY = "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js";

describe("ensureExtensionRelayDaemonProcess", () => {
  it.each(["pre-spawn error", "pending spawn", "late errors"] as const)(
    "spawn admission: %s",
    async (scenario) => {
      spawnMock.mockReset();
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      const invoked = createDeferred<void>();
      const failure = new Error("fixture spawn failed");
      const guard = vi.fn();
      // Keep the unguarded original inside this fixture, not a process-level unhandled error.
      child.on("error", guard);
      spawnMock.mockImplementation(() => {
        invoked.resolve();
        return child;
      });
      let settled = false;
      const observed = ensureExtensionRelayDaemonProcess({
        cfg: { browser: { profiles: { work: { driver: "extension", cdpPort: 19123 } } } },
        port: 19_123,
        entryPath: ENTRY,
        execPath: "/fixture/node",
        readToken: () => "a".repeat(64),
        probe: async () => false,
      }).then(
        (status) => {
          settled = true;
          return { status, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { status: undefined, error };
        },
      );
      try {
        await invoked.promise;
        expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
          "/fixture/node",
          [ENTRY, "--port", "19123"],
          { detached: true, stdio: "ignore" },
        );
        if (scenario === "pre-spawn error") {
          child.emit("error", failure);
          expect({ outcome: await observed, unrefs: child.unref.mock.calls.length }).toEqual({
            outcome: { status: undefined, error: failure },
            unrefs: 0,
          });
          expect(guard).toHaveBeenCalledExactlyOnceWith(failure);
          return;
        }
        if (scenario === "pending spawn") {
          await Promise.resolve();
          expect({ settled, unrefs: child.unref.mock.calls.length }).toEqual({
            settled: false,
            unrefs: 0,
          });
        }
        child.emit("spawn");
        expect(await observed).toEqual({ status: "spawned", error: undefined });
        expect(child.unref).toHaveBeenCalledOnce();
        if (scenario === "late errors") {
          child.removeListener("error", guard);
          expect(() => child.emit("error", new Error("fixture first late error"))).not.toThrow();
          expect(() => child.emit("error", new Error("fixture second late error"))).not.toThrow();
        }
      } finally {
        if (!settled) {
          child.emit("spawn");
        }
        await observed;
        child.removeListener("error", guard);
        spawnMock.mockReset();
      }
    },
  );

  it("skips when no relay credential exists", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: {},
      port: 18_799,
      entryPath: ENTRY,
      readToken: () => null,
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("skipped");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns the daemon entry with the resolved port", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: { browser: { profiles: { work: { driver: "extension", cdpPort: 19123 } } } },
      port: 19_123,
      entryPath: ENTRY,
      execPath: "/usr/bin/node",
      readToken: () => "a".repeat(64),
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("spawned");
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/node", [ENTRY, "--port", "19123"]);
  });
});

describe("relay port ownership", () => {
  it("leaves an existing listener alone and spawns only after it closes", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const spawnProcess = vi.fn();
    const params = {
      cfg: { browser: { profiles: { work: { driver: "extension" as const, cdpPort: port } } } },
      port,
      entryPath: ENTRY,
      readToken: () => "a".repeat(64),
      spawnProcess,
    };
    try {
      expect(await ensureExtensionRelayDaemonProcess(params)).toBe("running");
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    expect(await ensureExtensionRelayDaemonProcess(params)).toBe("spawned");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });
});
