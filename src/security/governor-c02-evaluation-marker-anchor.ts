import fs from "node:fs";
import path from "node:path";

export type C02MarkerDirectoryAnchor = Readonly<{
  descriptor: number;
  namespace: string;
  directPath: string;
  ancestors?: readonly C02MarkerDirectoryAnchor[];
}>;

export type C02MarkerTestHooks = Readonly<{
  afterParentValidationBeforeChildOpen?: (name: string) => void;
  afterChildOpenBeforeLeafPublication?: () => void;
}>;

function sameEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryFlags(): number {
  const constants = fs.constants as Readonly<Record<string, number | undefined>>;
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("C02_RESTART_MARKER_FD_ANCHOR_UNAVAILABLE");
  }
  return fs.constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function assertPrivateDirectory(stat: fs.Stats): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0)
  ) {
    throw new Error("C02_RESTART_MARKER_DIRECTORY_INVALID");
  }
}

function namespaceFor(descriptor: number, expected: fs.Stats, directPath: string): string {
  if (process.platform !== "linux") {
    return directPath;
  }
  const candidate = `/proc/self/fd/${descriptor}`;
  try {
    const probe = fs.openSync(candidate, fs.constants.O_RDONLY);
    try {
      if (sameEntry(fs.fstatSync(probe), expected)) {
        return candidate;
      }
    } finally {
      fs.closeSync(probe);
    }
  } catch {
    // Alistar's Linux runtime requires this fd namespace for C02 F publication.
  }
  throw new Error("C02_RESTART_MARKER_FD_ANCHOR_UNAVAILABLE");
}

export function openC02MarkerDirectory(
  file: string,
  privateMode: boolean,
): C02MarkerDirectoryAnchor {
  const descriptor = fs.openSync(file, directoryFlags());
  try {
    let stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_DIRECTORY_INVALID");
    }
    if (privateMode) {
      fs.fchmodSync(descriptor, 0o700);
      stat = fs.fstatSync(descriptor);
    }
    assertPrivateDirectory(stat);
    const finalPathStat = fs.lstatSync(file);
    if (finalPathStat.isSymbolicLink() || !sameEntry(stat, finalPathStat)) {
      throw new Error("C02_RESTART_MARKER_DIRECTORY_INVALID");
    }
    return Object.freeze({
      descriptor,
      namespace: namespaceFor(descriptor, stat, file),
      directPath: file,
    });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertStableAnchor(directory: C02MarkerDirectoryAnchor): void {
  if (process.platform !== "linux") {
    const stat = fs.fstatSync(directory.descriptor);
    const pathStat = fs.lstatSync(directory.namespace);
    if (pathStat.isSymbolicLink() || !sameEntry(stat, pathStat)) {
      throw new Error("C02_RESTART_MARKER_FD_ANCHOR_INVALID");
    }
  }
}

function assertChildMatchesParent(
  parent: C02MarkerDirectoryAnchor,
  child: C02MarkerDirectoryAnchor,
): void {
  if (process.platform === "linux") {
    return;
  }
  assertStableAnchor(parent);
  assertStableAnchor(child);
  const parentStat = fs.lstatSync(path.dirname(child.directPath));
  if (parentStat.isSymbolicLink() || !sameEntry(fs.fstatSync(parent.descriptor), parentStat)) {
    throw new Error("C02_RESTART_MARKER_FD_ANCHOR_INVALID");
  }
}

export function assertC02MarkerDirectoryStable(directory: C02MarkerDirectoryAnchor): void {
  const chain = [...(directory.ancestors ?? []), directory];
  for (const anchor of chain) {
    assertStableAnchor(anchor);
  }
  for (let index = 1; index < chain.length; index += 1) {
    assertChildMatchesParent(chain[index - 1]!, chain[index]!);
  }
}

export function createOrOpenC02MarkerChild(
  parent: C02MarkerDirectoryAnchor,
  name: string,
  hooks?: C02MarkerTestHooks,
): C02MarkerDirectoryAnchor {
  const child = path.join(parent.namespace, name);
  try {
    fs.mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  assertStableAnchor(parent);
  hooks?.afterParentValidationBeforeChildOpen?.(name);
  const opened = openC02MarkerDirectory(child, true);
  try {
    assertChildMatchesParent(parent, opened);
    return opened;
  } catch (error) {
    fs.closeSync(opened.descriptor);
    throw error;
  }
}

export function withC02MarkerAncestors(
  marker: C02MarkerDirectoryAnchor,
  ancestors: readonly C02MarkerDirectoryAnchor[],
): C02MarkerDirectoryAnchor {
  return Object.freeze({ ...marker, ancestors: Object.freeze([...ancestors]) });
}

export function c02MarkerLeaf(directory: C02MarkerDirectoryAnchor, name: string): string {
  assertC02MarkerDirectoryStable(directory);
  return path.join(directory.namespace, name);
}
