import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";

export function governorArgumentsDigest(value: GovernorJsonValue): string {
  return governorDigest(value);
}
