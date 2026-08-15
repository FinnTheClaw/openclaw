import { digestFunctionalFinnFrame } from "./functional-finn-release-receipt.js";

export type FunctionalFinnSignalFrame = {
  schemaVersion: 1;
  method: "send";
  accountId: string;
  targetDigest: string;
  params: Record<string, unknown>;
};

export function buildFunctionalFinnSignalFrame(params: {
  accountId: string;
  targetDigest: string;
  rpcParams: Record<string, unknown>;
}): FunctionalFinnSignalFrame {
  return {
    schemaVersion: 1,
    method: "send",
    accountId: params.accountId,
    targetDigest: params.targetDigest,
    params: params.rpcParams,
  };
}

export function digestFunctionalFinnSignalFrame(frame: FunctionalFinnSignalFrame): string {
  return digestFunctionalFinnFrame(frame);
}
