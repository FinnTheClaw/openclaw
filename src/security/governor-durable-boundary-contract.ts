/** Shared shape for the security-owned durable boundary inventory. */
export type GovernorDurableBoundary = Readonly<{
  id: string;
  file: `src/${string}.ts`;
  symbol: string;
  direction: "read" | "write" | "read-write";
  enforcementAnchors: readonly [string, ...string[]];
  rawDurableOperation?: Readonly<{
    kind: "schema-bootstrap" | "migration" | "coordination";
    schemaVersionGuard: string;
    transactionRule: string;
    recoveryRule: string;
    testFile: `src/${string}.test.ts`;
  }>;
}>;

export function governorDurableBoundary(
  id: string,
  file: GovernorDurableBoundary["file"],
  symbol: string,
  direction: GovernorDurableBoundary["direction"],
  enforcementAnchors: GovernorDurableBoundary["enforcementAnchors"],
  rawDurableOperation?: GovernorDurableBoundary["rawDurableOperation"],
): GovernorDurableBoundary {
  return {
    id,
    file,
    symbol,
    direction,
    enforcementAnchors,
    ...(rawDurableOperation ? { rawDurableOperation } : {}),
  };
}
