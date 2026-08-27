import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { emitChildDispatchProtocolEvent } from "./subagent-child-dispatch-process-protocol.js";

const counter = (() => {
  const value = process.env.MODEL_COUNTER;
  if (!value) {
    throw new Error("MODEL_COUNTER is required");
  }
  return value;
})();
const protocolPath = process.env.CHILD_DISPATCH_PROTOCOL;

async function record(): Promise<void> {
  const handle = await open(counter, "a");
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, time: Date.now() })}\n`);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

const server = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
    return;
  }
  request.resume();
  request.once("end", () => {
    void record().then(async () => {
      if (protocolPath) {
        await emitChildDispatchProtocolEvent({
          path: protocolPath,
          id: randomUUID(),
          point: "model.request",
          payload: { provider: "loopback-embedded", model: "fake-model" },
        });
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "child-dispatch-model",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "PROCESS-PROBE" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({ id: "child-dispatch-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("model server address missing");
}
process.stdout.write(`READY ${JSON.stringify({ port: address.port })}\n`);
const control = createInterface({ input: process.stdin });
control.on("line", (line) => {
  if (line !== "CLOSE" && line !== '{"op":"close"}') {
    return;
  }
  void new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  }).then(() => {
    process.stdout.write("CLOSED\n");
    control.close();
    process.exit(0);
  });
});
