import path from "node:path";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parseGitUrl } from "./utils/git.js";

const MAX_PROJECT_KEY_CACHE_ENTRIES = 128;
// Cheap git reads elsewhere bound at 4s (see detectGitRoot in infra/update-check.ts).
const GIT_CONFIG_TIMEOUT_MS = 4_000;

const projectKeyByRepoRoot = new Map<string, Promise<string>>();
const DEFAULT_GIT_ORIGIN_PORTS: Record<string, string> = { "ssh:": "22", "git:": "9418" };

function escapeProjectKeyForAnnotation(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(";", "%3b")
    .replaceAll("<", "%3c")
    .replaceAll(">", "%3e")
    .replaceAll("\r", "%0d")
    .replaceAll("\n", "%0a");
}

function resolveProjectMemoryOriginHost(remoteUrl: string, parsedHost: string): string {
  const host = parsedHost.toLowerCase();
  // Only explicit URL origins can carry a port. SCP-style and shorthand origins
  // retain the host identity returned by the shared Git parser.
  if (!/^(?:https?|ssh|git):\/\//i.test(remoteUrl)) {
    return host;
  }
  try {
    const url = new URL(remoteUrl);
    // URL already normalizes HTTP(S) default ports away. Normalize the Git/SSH
    // defaults too so equivalent URL and SCP-style origins still converge.
    const port = url.port;
    return port && port !== DEFAULT_GIT_ORIGIN_PORTS[url.protocol] ? `${host}:${port}` : host;
  } catch {
    return host;
  }
}

async function resolveUncachedProjectKey(repoRoot: string): Promise<string> {
  try {
    const result = await runCommandWithTimeout(
      ["git", "-C", repoRoot, "config", "--get", "remote.origin.url"],
      { timeoutMs: GIT_CONFIG_TIMEOUT_MS },
    );
    if (result.code === 0) {
      const remoteUrl = result.stdout.trim();
      const source = parseGitUrl(`git:${remoteUrl}`);
      if (source) {
        // Userinfo is deliberately folded out so SSH and HTTPS clones converge.
        // This accepts a rare same-host, same-path collision across distinct SSH
        // accounts; the tradeoff is relevance bleed within one operator's store.
        // Preserve remote path case so case-sensitive hosts fail closed. Providers
        // with case-insensitive slugs may miss boosts/digests across casing variants,
        // but folding paths could cross-inject memory between distinct repositories.
        // A nondefault origin port names a different repository endpoint; omitting
        // it would allow another endpoint's curated memory into this project.
        return escapeProjectKeyForAnnotation(
          `${resolveProjectMemoryOriginHost(remoteUrl, source.host)}/${source.path}`,
        );
      }
    }
  } catch {
    // Repositories without an origin intentionally use their canonical local root.
  }
  return `path:${escapeProjectKeyForAnnotation(repoRoot)}`;
}

/** Resolve one stable repository identity without spawning Git again for the same root. */
export function resolveProjectKey(repoRoot: string): Promise<string> {
  const canonicalRoot = path.resolve(repoRoot);
  const cached = projectKeyByRepoRoot.get(canonicalRoot);
  if (cached) {
    projectKeyByRepoRoot.delete(canonicalRoot);
    projectKeyByRepoRoot.set(canonicalRoot, cached);
    return cached;
  }
  const pending = resolveUncachedProjectKey(canonicalRoot);
  projectKeyByRepoRoot.set(canonicalRoot, pending);
  pruneMapToMaxSize(projectKeyByRepoRoot, MAX_PROJECT_KEY_CACHE_ENTRIES);
  return pending;
}
