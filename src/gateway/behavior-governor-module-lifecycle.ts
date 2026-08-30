import type { BehaviorGovernorModuleSelection } from "../config/types.behavior-governor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  installGatewayBehaviorGovernorModuleAgentLoop,
  type GatewayBehaviorGovernorModuleActivation,
  type GatewayBehaviorGovernorModuleAgentLoop,
  type GatewayBehaviorGovernorModuleAgentLoopHandle,
} from "./behavior-governor-module-agent-loop.js";
import type {
  GatewayBehaviorGovernorModuleHostCapability,
  GatewayBehaviorGovernorModuleHostLease,
  GatewayBehaviorGovernorModuleHostProvider,
} from "./behavior-governor-module-host.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const BOUNDARY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type GatewayBehaviorGovernorModuleRuntime = Readonly<{
  agentLoop?: GatewayBehaviorGovernorModuleAgentLoop;
  freeze?: () => void | Promise<void>;
  close: () => void | Promise<void>;
}>;

/** The lifecycle is the sole activation seam; module imports must stay inert. */
export type GatewayBehaviorGovernorModuleActivationContext =
  GatewayBehaviorGovernorModuleActivation &
    Readonly<{ host: GatewayBehaviorGovernorModuleHostCapability }>;

export type GatewayBehaviorGovernorModuleFactory = (
  context: GatewayBehaviorGovernorModuleActivationContext,
) => GatewayBehaviorGovernorModuleRuntime | Promise<GatewayBehaviorGovernorModuleRuntime>;

export type GatewayBehaviorGovernorModuleDescriptor = Readonly<{
  id: string;
  version: string;
  supportedModes: readonly BehaviorGovernorModuleSelection["mode"][];
  qualifiedModes: readonly BehaviorGovernorModuleSelection["mode"][];
  dependencies: readonly string[];
  durableBoundaryIds: readonly string[];
  load: () => Promise<GatewayBehaviorGovernorModuleFactory>;
}>;

export type GatewayBehaviorGovernorModuleLifecycle = Readonly<{
  apply: (
    selections: readonly BehaviorGovernorModuleSelection[],
    gatewayConfig?: OpenClawConfig,
  ) => Promise<void>;
  freeze: () => Promise<void>;
  close: () => Promise<void>;
}>;

type ResolvedModule = Readonly<{
  descriptor: GatewayBehaviorGovernorModuleDescriptor;
  selection: BehaviorGovernorModuleSelection;
}>;

type ActiveModule = Readonly<{
  activation: GatewayBehaviorGovernorModuleActivation;
  runtime: GatewayBehaviorGovernorModuleRuntime;
}>;

function aggregateWithCause(errors: unknown[], message: string, cause: unknown): AggregateError {
  return new AggregateError(errors, message, { cause });
}

function assertIdentifier(value: string, pattern: RegExp, code: string): void {
  if (!pattern.test(value)) {
    throw new Error(code);
  }
}

function assertModes(
  modes: readonly BehaviorGovernorModuleSelection["mode"][],
  code: string,
  allowEmpty = false,
): void {
  if (
    (!allowEmpty && modes.length === 0) ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => mode !== "shadow" && mode !== "enforce")
  ) {
    throw new Error(code);
  }
}

function validateCatalog(
  catalog: readonly GatewayBehaviorGovernorModuleDescriptor[],
): Map<string, GatewayBehaviorGovernorModuleDescriptor> {
  const byId = new Map<string, GatewayBehaviorGovernorModuleDescriptor>();
  for (const descriptor of catalog) {
    assertIdentifier(descriptor.id, MODULE_ID_PATTERN, "GOVERNOR_MODULE_ID_INVALID");
    assertIdentifier(descriptor.version, VERSION_PATTERN, "GOVERNOR_MODULE_VERSION_INVALID");
    assertModes(descriptor.supportedModes, "GOVERNOR_MODULE_SUPPORTED_MODES_INVALID");
    assertModes(descriptor.qualifiedModes, "GOVERNOR_MODULE_QUALIFIED_MODES_INVALID", true);
    for (const mode of descriptor.qualifiedModes) {
      if (!descriptor.supportedModes.includes(mode)) {
        throw new Error("GOVERNOR_MODULE_QUALIFIED_MODE_UNSUPPORTED");
      }
    }
    if (byId.has(descriptor.id)) {
      throw new Error("GOVERNOR_MODULE_CATALOG_DUPLICATE");
    }
    if (new Set(descriptor.dependencies).size !== descriptor.dependencies.length) {
      throw new Error("GOVERNOR_MODULE_DEPENDENCY_DUPLICATE");
    }
    if (new Set(descriptor.durableBoundaryIds).size !== descriptor.durableBoundaryIds.length) {
      throw new Error("GOVERNOR_MODULE_BOUNDARY_DUPLICATE");
    }
    for (const dependency of descriptor.dependencies) {
      assertIdentifier(dependency, MODULE_ID_PATTERN, "GOVERNOR_MODULE_DEPENDENCY_INVALID");
      if (dependency === descriptor.id) {
        throw new Error("GOVERNOR_MODULE_DEPENDENCY_CYCLE");
      }
    }
    for (const boundary of descriptor.durableBoundaryIds) {
      assertIdentifier(boundary, BOUNDARY_ID_PATTERN, "GOVERNOR_MODULE_BOUNDARY_INVALID");
    }
    byId.set(descriptor.id, descriptor);
  }
  return byId;
}

function resolveModules(params: {
  catalog: ReadonlyMap<string, GatewayBehaviorGovernorModuleDescriptor>;
  selections: readonly BehaviorGovernorModuleSelection[];
}): ResolvedModule[] {
  const selected = new Map<string, BehaviorGovernorModuleSelection>();
  for (const selection of params.selections) {
    assertIdentifier(selection.id, MODULE_ID_PATTERN, "GOVERNOR_MODULE_ID_INVALID");
    assertIdentifier(selection.version, VERSION_PATTERN, "GOVERNOR_MODULE_VERSION_INVALID");
    if (selection.mode !== "shadow" && selection.mode !== "enforce") {
      throw new Error("GOVERNOR_MODULE_MODE_INVALID");
    }
    if (selected.has(selection.id)) {
      throw new Error("GOVERNOR_MODULE_SELECTION_DUPLICATE");
    }
    const descriptor = params.catalog.get(selection.id);
    if (!descriptor) {
      throw new Error("GOVERNOR_MODULE_UNKNOWN");
    }
    if (descriptor.version !== selection.version) {
      throw new Error("GOVERNOR_MODULE_VERSION_MISMATCH");
    }
    if (!descriptor.supportedModes.includes(selection.mode)) {
      throw new Error("GOVERNOR_MODULE_MODE_UNSUPPORTED");
    }
    if (!descriptor.qualifiedModes.includes(selection.mode)) {
      throw new Error("GOVERNOR_MODULE_MODE_UNQUALIFIED");
    }
    selected.set(selection.id, selection);
  }

  const boundaryOwners = new Map<string, string>();
  for (const id of [...selected.keys()].toSorted()) {
    const descriptor = params.catalog.get(id)!;
    for (const dependency of descriptor.dependencies) {
      if (!selected.has(dependency)) {
        throw new Error("GOVERNOR_MODULE_DEPENDENCY_MISSING");
      }
    }
    for (const boundary of descriptor.durableBoundaryIds) {
      const owner = boundaryOwners.get(boundary);
      if (owner && owner !== id) {
        throw new Error("GOVERNOR_MODULE_BOUNDARY_CONFLICT");
      }
      boundaryOwners.set(boundary, id);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ResolvedModule[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error("GOVERNOR_MODULE_DEPENDENCY_CYCLE");
    }
    visiting.add(id);
    const descriptor = params.catalog.get(id)!;
    for (const dependency of [...descriptor.dependencies].toSorted()) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push({ descriptor, selection: selected.get(id)! });
  };
  for (const id of [...selected.keys()].toSorted()) {
    visit(id);
  }
  return ordered;
}

function planKey(selections: readonly BehaviorGovernorModuleSelection[]): string {
  return JSON.stringify(
    selections
      .map((selection) => ({ ...selection }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  );
}

export function createGatewayBehaviorGovernorModuleLifecycle(params: {
  catalog: readonly GatewayBehaviorGovernorModuleDescriptor[];
  hostProvider?: GatewayBehaviorGovernorModuleHostProvider;
}): GatewayBehaviorGovernorModuleLifecycle {
  const catalog = validateCatalog(params.catalog);
  let appliedKey: string | undefined;
  let active: ActiveModule[] = [];
  let agentLoop: GatewayBehaviorGovernorModuleAgentLoopHandle | undefined;
  let host: GatewayBehaviorGovernorModuleHostLease | undefined;
  let poisoned = false;
  let closed = false;
  let serial = Promise.resolve();

  const applyUnsafe = async (
    selections: readonly BehaviorGovernorModuleSelection[],
    gatewayConfig: OpenClawConfig,
  ) => {
    if (closed) {
      throw new Error("GOVERNOR_MODULE_LIFECYCLE_CLOSED");
    }
    if (poisoned) {
      throw new Error("GOVERNOR_MODULE_LIFECYCLE_POISONED");
    }
    const key = planKey(selections);
    if (appliedKey === key) {
      return;
    }
    if (appliedKey !== undefined) {
      throw new Error("GOVERNOR_MODULE_RESTART_REQUIRED");
    }
    const resolved = resolveModules({ catalog, selections });
    if (resolved.length === 0) {
      appliedKey = key;
      return;
    }
    if (!params.hostProvider) {
      throw new Error("GOVERNOR_MODULE_HOST_PROVIDER_REQUIRED");
    }
    let acquired: GatewayBehaviorGovernorModuleHostLease | undefined;
    const started: typeof active = [];
    try {
      acquired = await params.hostProvider.acquire({ gatewayConfig });
      for (const item of resolved) {
        const create = await item.descriptor.load();
        if (typeof create !== "function") {
          throw new Error("GOVERNOR_MODULE_FACTORY_INVALID");
        }
        const activation: GatewayBehaviorGovernorModuleActivation = Object.freeze({
          id: item.selection.id,
          mode: item.selection.mode,
          version: item.selection.version,
        });
        const runtime = await create(Object.freeze({ ...activation, host: acquired.capability }));
        if (!runtime || typeof runtime.close !== "function") {
          throw new Error("GOVERNOR_MODULE_RUNTIME_INVALID");
        }
        if (runtime.agentLoop && typeof runtime.agentLoop.resolveRunScope !== "function") {
          throw new Error("GOVERNOR_MODULE_AGENT_LOOP_INVALID");
        }
        started.push({ activation, runtime });
      }
      agentLoop = installGatewayBehaviorGovernorModuleAgentLoop(
        started.flatMap((item) =>
          item.runtime.agentLoop
            ? [{ activation: item.activation, agentLoop: item.runtime.agentLoop }]
            : [],
        ),
      );
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const survivors: typeof active = [];
      for (const item of started.toReversed()) {
        try {
          await item.runtime.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
          survivors.push(item);
        }
      }
      try {
        await acquired?.close();
        acquired = undefined;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      // Retain only runtimes whose close failed. Gateway shutdown can retry
      // those survivors without double-closing a runtime that already closed.
      active = survivors.toReversed();
      if (cleanupErrors.length > 0) {
        poisoned = true;
        throw aggregateWithCause(
          [error, ...cleanupErrors],
          "GOVERNOR_MODULE_STARTUP_CLEANUP_FAILED",
          error,
        );
      }
      throw error;
    }
    active = started;
    host = acquired;
    appliedKey = key;
  };

  const freezeUnsafe = async () => {
    const errors: unknown[] = [];
    agentLoop?.freeze();
    for (const item of active.toReversed()) {
      try {
        await item.runtime.freeze?.();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await host?.freeze();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_MODULE_FREEZE_FAILED");
    }
  };

  const closeUnsafe = async () => {
    if (closed) {
      return;
    }
    const errors: unknown[] = [];
    agentLoop?.close();
    agentLoop = undefined;
    const survivors: typeof active = [];
    for (const item of active.toReversed()) {
      try {
        await item.runtime.close();
      } catch (error) {
        errors.push(error);
        survivors.push(item);
      }
    }
    active = survivors.toReversed();
    try {
      await host?.close();
      host = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "GOVERNOR_MODULE_CLOSE_FAILED");
    }
    closed = true;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation);
    serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return Object.freeze({
    apply: (selections, gatewayConfig = {}) =>
      enqueue(() => applyUnsafe(selections, gatewayConfig)),
    freeze: () => enqueue(freezeUnsafe),
    close: () => enqueue(closeUnsafe),
  });
}
