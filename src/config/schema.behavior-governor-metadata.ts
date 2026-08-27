export const BEHAVIOR_GOVERNOR_FIELD_LABELS: Record<string, string> = {
  "experimental.behaviorGovernor": "Behavior Governor",
  "experimental.behaviorGovernor.mode": "Behavior Governor Mode",
  "experimental.behaviorGovernor.secretRefs": "Behavior Governor Secret References",
  "experimental.behaviorGovernor.agentLoop": "Behavior Governor Agent Loop",
  "experimental.behaviorGovernor.modules": "Behavior Governor Modules",
  "experimental.behaviorGovernor.modules.*.id": "Behavior Governor Module ID",
  "experimental.behaviorGovernor.modules.*.mode": "Behavior Governor Module Mode",
  "experimental.behaviorGovernor.modules.*.version": "Behavior Governor Module Version",
};

export const BEHAVIOR_GOVERNOR_FIELD_HELP: Record<string, string> = {
  "experimental.behaviorGovernor":
    "Host-owned behavior-governor rollout settings. Disabled or absent is inert; enabled startup fails closed until canonical SecretRefs and compiled host bindings are available.",
  "experimental.behaviorGovernor.mode":
    'Governor observation mode: "shadow" records decisions without changing tools, effects, continuation, or replies; "enforce" is reserved for a separately authorized rollout.',
  "experimental.behaviorGovernor.secretRefs":
    "Canonical SecretRefs resolved by startup secret authority. Plaintext governor secrets are not accepted.",
  "experimental.behaviorGovernor.agentLoop":
    "Data-only authenticated scopes, dependency criteria, attested tool bindings, and bounded loop settings. Host code remains the authority.",
  "experimental.behaviorGovernor.modules":
    "Exact compiled behavior modules selected for this gateway generation. An absent or empty list keeps the always-present modular skeleton inert; changing selections requires a gateway restart.",
  "experimental.behaviorGovernor.modules.*.id":
    "Compiled behavior-module identifier. Unknown modules fail closed and cannot be loaded from paths, URLs, or configuration data.",
  "experimental.behaviorGovernor.modules.*.mode":
    'Module mode: "shadow" observes without changing behavior; "enforce" applies the module contract after its independent qualification gate.',
  "experimental.behaviorGovernor.modules.*.version":
    "Exact compiled module version. Startup fails if it differs from the artifact-owned descriptor. Deployment separately verifies the whole frozen artifact SHA-256 and records it in the deployment ledger; module config does not self-attest code.",
};
