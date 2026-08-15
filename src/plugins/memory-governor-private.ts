import fs from "node:fs";
import path from "node:path";
import {
  type MemoryGovernorBackend,
  ownGovernorMemoryBackend,
} from "./memory-governor-capability.js";

type TrustedMemoryGovernorFactory = (
  params: Readonly<{
    mode: "enforce";
    authorityBindingKey: string;
  }>,
) => MemoryGovernorBackend;

export type BundledGovernorMemoryRegistrationHost = Readonly<{
  register(factory: TrustedMemoryGovernorFactory): void;
}>;

type GovernorMemoryFactorySnapshot = Readonly<{
  factory?: TrustedMemoryGovernorFactory;
}>;

let trustedFactory: TrustedMemoryGovernorFactory | undefined;
let ownerClaimed = false;

function realpath(value: string): string {
  return fs.realpathSync.native(path.resolve(value));
}

function isExactBundledMemoryImplementation(provenance: {
  id: string;
  origin: string;
  source: string;
  rootDir?: string;
}): boolean {
  if (
    provenance.id !== "memory-lancedb" ||
    provenance.origin !== "bundled" ||
    !provenance.rootDir
  ) {
    return false;
  }
  try {
    const expectedRoot = realpath(
      path.resolve(import.meta.dirname, "../../extensions/memory-lancedb"),
    );
    const root = realpath(provenance.rootDir);
    const source = realpath(provenance.source);
    return root === expectedRoot && source !== root && source.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

/** Creates a synchronous, one-registration host for the exact bundled implementation. */
function createBundledGovernorMemoryRegistrationHost(provenance: {
  id: string;
  origin: string;
  source: string;
  rootDir?: string;
}): Readonly<{
  host?: BundledGovernorMemoryRegistrationHost;
  commit(): void;
  close(): void;
}> {
  if (!isExactBundledMemoryImplementation(provenance)) {
    return Object.freeze({ commit: () => undefined, close: () => undefined });
  }
  let open = true;
  let used = false;
  let pending: TrustedMemoryGovernorFactory | undefined;
  const host: BundledGovernorMemoryRegistrationHost = Object.freeze({
    register(factory) {
      if (!open || used || typeof factory !== "function") {
        throw new Error("GOVERNOR_MEMORY_PRIVATE_REGISTRATION_CLOSED");
      }
      used = true;
      pending = factory;
    },
  });
  return Object.freeze({
    host,
    commit() {
      if (!open) {
        throw new Error("GOVERNOR_MEMORY_PRIVATE_REGISTRATION_CLOSED");
      }
      trustedFactory = pending;
    },
    close() {
      open = false;
    },
  });
}

export function createRegisteredGovernorMemoryBackend(
  params: Readonly<{
    mode: "enforce";
    authorityBindingKey: string;
  }>,
): MemoryGovernorBackend | undefined {
  if (!params.authorityBindingKey) {
    throw new Error("GOVERNOR_MEMORY_AUTHORITY_KEY_REQUIRED");
  }
  return trustedFactory
    ? ownGovernorMemoryBackend(trustedFactory(Object.freeze({ ...params })))
    : undefined;
}

function snapshotGovernorMemoryFactory(): GovernorMemoryFactorySnapshot {
  return Object.freeze(trustedFactory ? { factory: trustedFactory } : {});
}

function restoreGovernorMemoryFactory(snapshot: GovernorMemoryFactorySnapshot): void {
  trustedFactory = snapshot.factory;
}

function clearGovernorMemoryFactory(): void {
  trustedFactory = undefined;
}

export type GovernorMemoryFactoryOwner = Readonly<{
  createRegistrationHost: typeof createBundledGovernorMemoryRegistrationHost;
  snapshot: typeof snapshotGovernorMemoryFactory;
  restore: typeof restoreGovernorMemoryFactory;
  clear: typeof clearGovernorMemoryFactory;
}>;

/** Claimed once by the loader module before any plugin implementation executes. */
export function claimGovernorMemoryFactoryOwner(): GovernorMemoryFactoryOwner {
  if (ownerClaimed) {
    throw new Error("GOVERNOR_MEMORY_FACTORY_OWNER_ALREADY_CLAIMED");
  }
  ownerClaimed = true;
  return Object.freeze({
    createRegistrationHost: createBundledGovernorMemoryRegistrationHost,
    snapshot: snapshotGovernorMemoryFactory,
    restore: restoreGovernorMemoryFactory,
    clear: clearGovernorMemoryFactory,
  });
}
