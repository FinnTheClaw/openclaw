import crypto from "node:crypto";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import {
  CANDIDATES,
  ISSUED,
  SCHEMA,
  SHA256,
  type GovernorC02AttestationAuthority,
  dataRecord,
  deepFreeze,
  exactKeys,
  fail,
} from "./governor-c02-runtime-attestation-model.js";

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @internal Broker construction only; candidates cannot be manufactured by callers or tests. */
export function createGovernorC02AttestationAuthority(params: {
  sign: (value: GovernorJsonValue) => string;
  now?: () => number;
}): GovernorC02AttestationAuthority {
  return Object.freeze({
    issue(candidate) {
      if (!CANDIDATES.has(candidate) || ISSUED.has(candidate)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_CANDIDATE_INVALID");
      }
      const issuedAt = (params.now ?? Date.now)();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < candidate.taskCompletedAt) {
        fail();
      }
      const unsigned = {
        ...candidate,
        issuedAt,
        authorityKeyId: "host-receipt-v1" as const,
        authorityVersion: 1 as const,
      };
      const signature = params.sign({
        domain: SCHEMA,
        body: unsigned,
      } as unknown as GovernorJsonValue);
      const result = deepFreeze({ ...unsigned, signature });
      ISSUED.add(candidate);
      return result;
    },
    verify(attestation, candidate) {
      try {
        const record = dataRecord(attestation);
        if (
          !record ||
          !exactKeys(record, [
            ...Object.keys(candidate),
            "issuedAt",
            "authorityKeyId",
            "authorityVersion",
            "signature",
          ])
        ) {
          return false;
        }
        if (
          record.schema !== SCHEMA ||
          record.authorityKeyId !== "host-receipt-v1" ||
          record.authorityVersion !== 1 ||
          typeof record.issuedAt !== "number" ||
          !Number.isSafeInteger(record.issuedAt) ||
          record.issuedAt < candidate.taskCompletedAt ||
          typeof record.signature !== "string" ||
          !SHA256.test(record.signature)
        ) {
          return false;
        }
        const { signature, ...unsigned } = record;
        for (const [key, value] of Object.entries(candidate)) {
          if (
            governorDigest(value as GovernorJsonValue) !==
            governorDigest(record[key] as GovernorJsonValue)
          ) {
            return false;
          }
        }
        return timingSafeEqual(
          signature,
          params.sign({ domain: SCHEMA, body: unsigned as GovernorJsonValue }),
        );
      } catch {
        return false;
      }
    },
  });
}

/** @internal Broker-issued, domain-separated owner construction; no issuer or verifier escapes. */
