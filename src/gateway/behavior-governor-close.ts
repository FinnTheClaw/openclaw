import type { GatewayBehaviorGovernorLifecycle } from "./behavior-governor-lifecycle.js";

/** Revoke gateway-global signing authority before any fallible lifecycle cleanup. */
export async function revokeAndCloseBehaviorGovernor(params: {
  lifecycle: GatewayBehaviorGovernorLifecycle | undefined;
  revoke: () => void;
}): Promise<void> {
  params.revoke();
  await params.lifecycle?.close();
}
