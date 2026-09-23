// Covers best-effort cleanup error swallowing.
import { describe, expect, it, vi } from "vitest";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";

describe("runBestEffortCleanup", () => {
  it("returns the cleanup result when the cleanup succeeds", async () => {
    await expect(
      runBestEffortCleanup({
        cleanup: async () => 7,
      }),
    ).resolves.toBe(7);
  });

  it("swallows cleanup failure when the error callback throws an Error", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw new Error("callback failed");
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws a string", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw "callback failed";
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws null", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw null;
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws undefined", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw undefined;
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws a number", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw 42;
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws a symbol", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw Symbol("callback");
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws an object", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw { reason: "callback" };
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws the original error", async () => {
    const cleanupError = new Error("cleanup failed");
    const onError = vi.fn(() => {
      throw cleanupError;
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws after receiving a string rejection", async () => {
    const cleanupError = "cleanup failed";
    const onError = vi.fn(() => {
      throw new Error("callback failed");
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failure when the error callback throws after receiving a null rejection", async () => {
    const cleanupError = null;
    const onError = vi.fn(() => {
      throw new Error("callback failed");
    });

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw cleanupError;
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupError);
  });

  it("swallows cleanup failures and reports them through onError", async () => {
    const onError = vi.fn();
    const error = new Error("cleanup failed");

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw error;
        },
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
