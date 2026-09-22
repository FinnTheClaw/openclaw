import { spawnSync } from "node:child_process";
// Config reload source Docker tests cover the RPC status loop exit contract.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\''")}'`;
}

describe("config-reload-source-docker", () => {
  it("returns the failed RPC probe status after the deadline", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-config-reload-rpc-"));
    const fakeBin = path.join(root, "bin");
    const output = path.join(root, "rpc-status.log");
    const fakeNode = path.join(fakeBin, "node");
    mkdirSync(fakeBin);
    writeFileSync(
      fakeNode,
      "#!/usr/bin/env bash\nprintf 'controlled rpc failure\n' >&2\nexit 7\n",
      {
        mode: 0o755,
      },
    );
    chmodSync(fakeNode, 0o755);

    try {
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote("scripts/e2e/config-reload-source-docker.sh")}`,
            "docker_e2e_docker_cmd() {",
            '  local payload="$5"',
            `  payload="$(printf '%s\\n' "$payload" | sed '/^source \\/tmp\\/openclaw-test-state-env$/d; /^source scripts\\/lib\\/openclaw-e2e-instance.sh$/d; s/^entry=.*/entry=fake-entry/')"`,
            '  PATH="$FAKE_BIN:$PATH" /bin/bash -c "$payload"',
            "}",
            'if check_rpc_status "$OUTPUT" 1; then exit 99; else status=$?; fi',
            'printf "status=%s\n" "$status"',
            'exit "$status"',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, FAKE_BIN: fakeBin, OUTPUT: output },
        },
      );

      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(7);
      expect(result.stdout).toContain("status=7");
      expect(result.stderr).toContain("controlled rpc failure");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
