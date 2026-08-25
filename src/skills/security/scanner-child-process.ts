// Provenance helpers for child_process execution findings.

const EXEC_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

const CONVENTIONAL_NAMESPACE_RECEIVERS = new Set(["cp", "childProcess", "child_process"]);

export type ChildProcessBindings = {
  methodAliases: Set<string>;
  namespaceAliases: Set<string>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectMethodAliases(specifiers: string, aliases: Set<string>): void {
  for (const rawSpecifier of specifiers.split(",")) {
    const specifier = rawSpecifier.trim();
    const renamed =
      specifier.match(/^(\w+)\s+as\s+(\w+)$/) ?? specifier.match(/^(\w+)\s*:\s*(\w+)$/);
    if (renamed?.[1] && renamed[2] && EXEC_METHODS.has(renamed[1])) {
      aliases.add(renamed[2]);
    }
  }
}

export function collectChildProcessBindings(source: string): ChildProcessBindings {
  // Only bindings originating at child_process imports/requires may authorize
  // alias or computed-member findings; source-wide name correlation is unsafe.
  const methodAliases = new Set<string>();
  const namespaceAliases = new Set<string>();
  const esmNamed = /\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  const cjsNamed =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
  const namespacePatterns = [
    /\bimport\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g,
    /\bimport\s*\*\s*as\s+(\w+)\s*from\s*["'](?:node:)?child_process["']/g,
    /\b(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g,
  ];

  for (const pattern of [esmNamed, cjsNamed]) {
    for (const match of source.matchAll(pattern)) {
      collectMethodAliases(match[1] ?? "", methodAliases);
    }
  }
  for (const pattern of namespacePatterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        namespaceAliases.add(match[1]);
      }
    }
  }
  return { methodAliases, namespaceAliases };
}

export function findAliasedChildProcessCalls(
  line: string,
  methodAliases: ReadonlySet<string>,
): number[] {
  const indexes: number[] = [];
  for (const alias of methodAliases) {
    const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(alias)}\\s*\\(`, "g");
    for (const match of line.matchAll(pattern)) {
      indexes.push(match.index ?? -1);
    }
  }
  return indexes.toSorted((left, right) => left - right);
}

function isKnownNamespace(receiver: string | undefined, aliases: ReadonlySet<string>): boolean {
  return Boolean(
    receiver && (aliases.has(receiver) || CONVENTIONAL_NAMESPACE_RECEIVERS.has(receiver)),
  );
}

export function isBenignChildProcessMatch(
  line: string,
  match: RegExpExecArray,
  namespaceAliases: ReadonlySet<string>,
): boolean {
  const command = match[1] ?? match[2];
  const matchIndex = match.index ?? -1;
  if (!command || matchIndex < 0) {
    return false;
  }

  if (line[matchIndex] === '"' || line[matchIndex] === "'") {
    const receiver = line.slice(0, matchIndex).match(/(\w+)\s*\[\s*$/)?.[1];
    return !isKnownNamespace(receiver, namespaceAliases);
  }

  if (matchIndex > 0 && line[matchIndex - 1] === ".") {
    const receiver = line.slice(0, matchIndex - 1).match(/(\w+)\s*$/)?.[1];
    return !isKnownNamespace(receiver, namespaceAliases);
  }
  return false;
}
