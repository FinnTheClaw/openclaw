import net from "node:net";
import type { FunctionalFinnAnswerEnvelope, FunctionalFinnEvidence } from "./answer-envelope.js";

const MAX_RESPONSE_BYTES = 256 * 1024;

export type FunctionalFinnVerifierRequest =
  | {
      operation: "validate" | "verify_and_sign";
      agentId: string;
      sessionKey: string;
      runId: string;
      accountId?: string;
      target?: string;
      envelope: FunctionalFinnAnswerEnvelope;
      evidence: FunctionalFinnEvidence[];
    }
  | {
      operation: "verify_memory";
      agentId: string;
      claim: string;
      evidence: FunctionalFinnEvidence;
      sourceStart: number;
      sourceEnd: number;
      sourceQuote: string;
    };

export type FunctionalFinnVerifierResponse =
  | { ok: true; receipt?: Record<string, unknown> }
  | { ok: false; code: string };

export async function requestFunctionalFinnVerifier(params: {
  socketPath: string;
  timeoutMs: number;
  request: FunctionalFinnVerifierRequest;
}): Promise<FunctionalFinnVerifierResponse> {
  const payload = `${JSON.stringify({ schemaVersion: 1, ...params.request })}\n`;
  if (Buffer.byteLength(payload) > 512 * 1024) {
    throw new Error("Functional Finn verifier request is oversized");
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(params.socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) {
        reject(error);
      }
    };
    socket.setTimeout(params.timeoutMs, () =>
      finish(new Error("Functional Finn verifier timed out")),
    );
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("Functional Finn verifier response is oversized"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !response ||
          typeof response !== "object" ||
          typeof response.ok !== "boolean" ||
          (response.ok === false && typeof response.code !== "string")
        ) {
          throw new Error("Functional Finn verifier returned an invalid response");
        }
        resolve(response as FunctionalFinnVerifierResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => socket.end(payload));
  });
}
