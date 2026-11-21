import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { hasErrnoCode } from "../infra/errno.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type {
  GatewayServiceCommandSnapshot,
  GatewayServiceEnv,
  GatewayServiceEnvironmentValueSource,
} from "./service-types.js";
import { parseSystemdEnvironmentFile } from "./systemd-environment-file-parser.js";

export type SystemdEnvironmentFileSpec = [pathname: string, optional: boolean];
export type SystemdEnvironmentFilesParams = {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  failOnUnavailable?: boolean;
};

export function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  return input.replace(/%%|%h/gu, (specifier) =>
    specifier === "%%" ? "%" : normalizeWindowsPathSeparators(resolveDaemonHomeDir(env)),
  );
}

export function parseSystemdEnvironmentFileSpec(
  value: string,
  env: GatewayServiceEnv,
): SystemdEnvironmentFileSpec | undefined {
  const optional = value.startsWith("-");
  const pathname = expandSystemdSpecifier(optional ? value.slice(1) : value, env);
  // Native systemd ignores relative declarations rather than resolving them beside the unit.
  return path.posix.isAbsolute(pathname) ? [pathname, optional] : undefined;
}

async function expandSystemdEnvironmentFilePattern(pattern: string): Promise<string[]> {
  const [parts] = new Minimatch(pattern, {
    nobrace: true,
    noext: true,
    noglobstar: true,
    platform: "linux",
    optimizationLevel: 0,
  }).set;
  if (!parts) {
    return [];
  }
  if (parts.every((part) => typeof part === "string")) {
    return [parts.join("/")];
  }
  // Node's fs.glob treats backslashes as separators. Match the parsed POSIX
  // components instead, preserving escaped literals and symlink-sensitive parent segments.
  let pathnames = ["/"];
  for (const part of parts.slice(1)) {
    const matches: string[] = [];
    for (const parent of pathnames) {
      const prefix = parent.endsWith("/") ? parent : `${parent}/`;
      if (typeof part === "string") {
        matches.push(`${prefix}${part}`);
        continue;
      }
      try {
        for (const entry of await fs.readdir(parent)) {
          if (part instanceof RegExp && part.test(entry)) {
            matches.push(`${prefix}${entry}`);
          }
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
          throw error;
        }
      }
    }
    pathnames = matches;
  }
  const existing: string[] = [];
  for (const pathname of pathnames) {
    if (await lstatIfExists(pathname)) {
      existing.push(pathname);
    }
  }
  return existing;
}

function serializeSystemdEnvironmentFileValue(value: string): string {
  // Quote only systemd's supported escapes so credential bytes survive EnvironmentFile parsing.
  if (!/[\s\\'"`$]/u.test(value)) {
    return value;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$");
  return `"${escaped}"`;
}

export function serializeSystemdEnvironmentFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${serializeSystemdEnvironmentFileValue(value)}`)
    .join("\n");
}

export async function readSystemdEnvironmentFile(pathname: string) {
  const environment: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const content = await fs.readFile(pathname, "utf8");
  for (const parsed of parseSystemdEnvironmentFile(content)) {
    environment[parsed.key] = parsed.value;
    if (parsed.literalShellReference) {
      literalShellReferenceKeys.add(parsed.key);
    } else {
      literalShellReferenceKeys.delete(parsed.key);
    }
  }
  return { environment, literalShellReferenceKeys };
}

export async function resolveSystemdEnvironmentFiles(
  params: SystemdEnvironmentFilesParams,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const failIfUnavailable = (error: unknown, optional: boolean) => {
    if (params.failOnUnavailable && !optional) {
      throw error;
    }
  };
  for (const [pattern, optional] of params.environmentFileSpecs) {
    let pathnames: string[];
    try {
      pathnames = await expandSystemdEnvironmentFilePattern(pattern);
    } catch (error) {
      failIfUnavailable(error, optional);
      continue;
    }
    pathnames.sort();
    if (params.failOnUnavailable && !optional && pathnames.length === 0) {
      throw new Error("Missing systemd environment file");
    }
    for (const filePath of pathnames) {
      try {
        Object.assign(resolved, (await readSystemdEnvironmentFile(filePath)).environment);
      } catch (error) {
        failIfUnavailable(error, optional);
        // Diagnostics skip unavailable files, including non-optional ones.
        continue;
      }
    }
  }
  return resolved;
}

type SystemdCommandSnapshotParams = SystemdEnvironmentFilesParams & {
  programArguments: string[];
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  unsetEnvironment: string[];
};

export async function buildSystemdCommandSnapshot(
  params: SystemdCommandSnapshotParams,
): Promise<GatewayServiceCommandSnapshot> {
  const fileEnvironment = await resolveSystemdEnvironmentFiles(params);
  const environment = { ...params.inlineEnvironment, ...fileEnvironment };
  const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> =
    Object.fromEntries(Object.keys(params.inlineEnvironment).map((key) => [key, "inline"]));
  for (const key of Object.keys(fileEnvironment)) {
    environmentValueSources[key] = Object.hasOwn(params.inlineEnvironment, key)
      ? "inline-and-file"
      : "file";
  }
  for (const assignment of params.unsetEnvironment) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    if (separator < 0 || environment[key] === assignment.slice(separator + 1)) {
      delete environment[key];
      delete environmentValueSources[key];
    }
  }
  return {
    programArguments: params.programArguments,
    ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
    ...(Object.keys(environment).length > 0 ? { environment, environmentValueSources } : {}),
  };
}
