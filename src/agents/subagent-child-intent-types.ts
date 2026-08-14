export type ChildIntentState =
  | "reserved"
  | "dispatch_claimed"
  | "gateway_accepted"
  | "registered"
  | "cancelled_requested"
  | "expired"
  | "legacy_ambiguous"
  | "terminal";
