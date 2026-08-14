export type GatewayAcceptanceReceiptLifecycle =
  | "preaccepted"
  | "runnable"
  | "dispatch_claimed"
  | "accepted"
  | "started"
  | "failed_before_start"
  | "failed_after_start"
  | "unknown"
  | "not_accepted"
  | "cancel_requested"
  | "cancelled"
  | "terminal";
