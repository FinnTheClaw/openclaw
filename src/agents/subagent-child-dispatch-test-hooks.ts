/**
 * Process-local hooks used only by the isolated child-dispatch protocol tests.
 * Production has no installed hooks, so the default path is a direct allow.
 */
export type ChildDispatchBarrierPoint =
  | "intent.reserved"
  | "receipt.preaccepted"
  | "receipt.runnable"
  | "receipt.dispatch_claimed"
  | "gateway_accepted.persisted_before_register"
  | "before.provider_start_cas"
  | "receipt.started"
  | "provider.completed"
  | "provider.failed"
  | "cancel.before_cas"
  | "cancel.after_cas";

export type ChildDispatchBarrierContext = Readonly<{
  point: ChildDispatchBarrierPoint;
  acceptanceKey?: string;
  gatewayRunId?: string;
  childSessionKey?: string;
  childIntentKey?: string;
  controllerSessionKey?: string;
  operationKey?: string;
  provider?: string;
}>;

export type ChildDispatchTestHooks = Readonly<{
  onBarrier?: (context: ChildDispatchBarrierContext) => Promise<"allow" | "deny">;
}>;

let installedHooks: ChildDispatchTestHooks | undefined;

export function installChildDispatchTestHooksForProcess(hooks: ChildDispatchTestHooks): void {
  installedHooks = hooks;
}

export function clearChildDispatchTestHooksForProcess(): void {
  installedHooks = undefined;
}

export async function awaitChildDispatchBarrier(
  context: ChildDispatchBarrierContext,
): Promise<"allow" | "deny"> {
  const hook = installedHooks?.onBarrier;
  return hook ? await hook(context) : "allow";
}
