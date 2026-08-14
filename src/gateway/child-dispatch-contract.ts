const PRIVATE_FIELDS = [
  "childIntentRequestDigest",
  "childIntentResolvedDigest",
  "childIntentControllerSessionKey",
  "childIntentCanonicalKey",
  "childIntentIdentityKind",
  "childIntentIdentityValue",
  "childIntentReceiptMode",
  "childIntentCapability",
] as const;

export function stripChildDispatchFields(params: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...params };
  for (const field of PRIVATE_FIELDS) {
    delete copy[field];
  }
  return copy;
}
