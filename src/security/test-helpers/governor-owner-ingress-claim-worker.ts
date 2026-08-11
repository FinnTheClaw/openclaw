import fs from "node:fs";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGovernorTestHostBindings,
  type HostGovernorOwnerIngressReceiptId,
} from "../governor-host-readonly.js";

const [stateDir, receiptId, nowValue, outputPath] = process.argv.slice(2);
if (!stateDir || !receiptId || !nowValue || !outputPath) {
  throw new Error("Governor owner-ingress claim worker arguments are required");
}

let claimed = false;
let errored = false;
let errorMessage = "";
try {
  const broker = createGovernorTestHostBindings({ stateDir });
  claimed = Boolean(
    broker.ownerIngressResolver.claim(
      receiptId as HostGovernorOwnerIngressReceiptId,
      Number(nowValue),
    ),
  );
} catch (error) {
  errored = true;
  errorMessage = error instanceof Error ? error.message : String(error);
} finally {
  closeOpenClawStateDatabase();
  fs.writeFileSync(outputPath, JSON.stringify({ claimed, errored, errorMessage }));
}
