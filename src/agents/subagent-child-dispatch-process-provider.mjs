import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const counter = process.env.PHYSICAL_COUNTER;
if (!counter) {
  throw new Error("PHYSICAL_COUNTER is required");
}

function emit(point, payload = {}) {
  const pathname = process.env.CHILD_DISPATCH_PROTOCOL;
  if (!pathname) {
    return;
  }
  const fd = fs.openSync(pathname, "a");
  try {
    fs.writeSync(
      fd,
      `${JSON.stringify({ version: 1, kind: "event", id: crypto.randomUUID(), point, payload })}\n`,
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function record(kind) {
  const fd = fs.openSync(counter, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify({ kind, pid: process.pid, time: Date.now() })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

if (process.env.CLAUDE_LIVE === "1") {
  const sessionId = `child-dispatch-${process.pid}`;
  process.stdout.write(`${JSON.stringify({ type: "init", session_id: sessionId })}\n`);
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", () => {
    record("claude-turn");
    emit("physical.start", { kind: "claude-turn" });
    process.stdout.write(
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "CLAUDE-PROBE" }] } })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ type: "result", session_id: sessionId, result: "CLAUDE-PROBE" })}\n`,
    );
  });
} else {
  record("cli-start");
  emit("physical.start", { kind: "cli" });
  process.stdout.write("CLI-PROBE\n");
}
