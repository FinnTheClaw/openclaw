// Ten-case progress-delivery failure pack for the production node PTY command.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { runNodePtyCommand } from "./pty-command.js";

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

async function fakeCase(emitChunk: (chunk: string) => Promise<void>) {
  let data: ((chunk: string) => void) | undefined;
  let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  let input: ((payload: string) => void) | undefined;
  const abort = new AbortController();
  const pty = {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: (callback: (chunk: string) => void) => {
      data = callback;
    },
    onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
      exit = callback;
    },
  };
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: abort.signal,
    emitChunk,
    onInput: (callback) => {
      input = callback;
    },
  };
  const result = outcome(
    runNodePtyCommand(
      { file: process.execPath, args: [], cols: 80, rows: 24 },
      io,
      vi.fn(async () => pty),
    ),
  );
  await vi.waitFor(() => {
    expect(data).toBeDefined();
    expect(exit).toBeDefined();
  });
  return {
    abort,
    pty,
    emit: (chunk: string) => data?.(chunk),
    finish: (code = 0) => exit?.({ exitCode: code }),
    input: (payload: string) => input?.(payload),
    result,
  };
}

describe("node PTY progress rejection (ten named cases)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("P01 first async emission rejects and command settles as failed", async () => {
    const error = new Error("progress unavailable");
    const emitChunk = vi.fn(async () => {
      throw error;
    });
    const run = await fakeCase(emitChunk);
    run.emit("first");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish(130);
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P02 second rejection keeps first delivered but never reports success", async () => {
    const error = new Error("second progress failed");
    const emitChunk = vi.fn(async (chunk: string) => {
      if (chunk === "second") {
        throw error;
      }
    });
    const run = await fakeCase(emitChunk);
    run.emit("first");
    run.emit("second");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish();
    expect(emitChunk.mock.calls.map(([chunk]) => chunk)).toEqual(["first", "second"]);
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P03 synchronous emitter throw becomes command failure", async () => {
    const error = new Error("sync progress failed");
    const run = await fakeCase(() => {
      throw error;
    });
    run.emit("chunk");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish();
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P04 exit before pending emission rejection does not hang or resolve", async () => {
    const error = new Error("late progress failed");
    let rejectEmission: ((reason: Error) => void) | undefined;
    const run = await fakeCase(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEmission = reject;
        }),
    );
    run.emit("pending");
    await vi.waitFor(() => expect(rejectEmission).toBeDefined());
    run.finish();
    rejectEmission?.(error);
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P05 progress rejection racing an abort settles one owned invocation", async () => {
    const error = new Error("progress failed");
    let rejectEmission: ((reason: Error) => void) | undefined;
    const run = await fakeCase(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEmission = reject;
        }),
    );
    run.emit("pending");
    await vi.waitFor(() => expect(rejectEmission).toBeDefined());
    run.abort.abort();
    rejectEmission?.(error);
    run.finish(130);
    expect(await run.result).toEqual({ ok: false, error });
    expect(run.pty.kill).toHaveBeenCalled();
  });

  it("P06 a queued later chunk is not delivered after first rejection", async () => {
    const error = new Error("first failed");
    const emitChunk = vi.fn(async () => {
      throw error;
    });
    const run = await fakeCase(emitChunk);
    run.emit("first");
    run.emit("second");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish();
    expect(emitChunk).toHaveBeenCalledTimes(1);
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P07 resume cleanup throw does not poison the output queue", async () => {
    const error = new Error("resume failed");
    const run = await fakeCase(async () => {});
    run.pty.resume.mockImplementationOnce(() => {
      throw error;
    });
    run.emit("chunk");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish();
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P08 kill cleanup throw preserves the original progress error", async () => {
    const error = new Error("progress failed");
    const run = await fakeCase(async () => {
      throw error;
    });
    run.pty.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });
    run.emit("chunk");
    await vi.waitFor(() => expect(run.pty.kill).toHaveBeenCalledOnce());
    run.finish();
    expect(await run.result).toEqual({ ok: false, error });
  });

  it("P09 real PTY normally emits output and exits", async () => {
    const chunks: string[] = [];
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: new AbortController().signal,
      emitChunk: async (chunk) => {
        chunks.push(chunk);
      },
      onInput: vi.fn(),
    };
    const result = await runNodePtyCommand(
      {
        file: process.execPath,
        args: ["-e", "setTimeout(() => { process.stdout.write('P09-REAL\\n'); }, 30)"],
        cols: 80,
        rows: 24,
      },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("P09-REAL");
  });

  it("P10 real PTY input and resize preserve duplex behavior", async () => {
    const chunks: string[] = [];
    let input: ((payload: string) => void) | undefined;
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: new AbortController().signal,
      emitChunk: async (chunk) => {
        chunks.push(chunk);
      },
      onInput: (callback) => {
        input = callback;
      },
    };
    const result = runNodePtyCommand(
      {
        file: process.execPath,
        args: [
          "-e",
          "process.stdin.once('data', d => { process.stdout.write('P10:' + d.toString().trim()); process.exit(0); })",
        ],
        cols: 80,
        rows: 24,
      },
      io,
    );
    await vi.waitFor(() => expect(input).toBeDefined());
    input?.(JSON.stringify({ kind: "resize", cols: 90, rows: 25 }));
    input?.(JSON.stringify({ kind: "data", data: "echo-this\n" }));
    expect((await result).exitCode).toBe(0);
    expect(chunks.join("")).toContain("P10:echo-this");
  });
});
