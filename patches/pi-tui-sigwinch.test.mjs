import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PI_TUI_TEST_MODULE;
assert.ok(modulePath, "Set PI_TUI_TEST_MODULE to the exact package dist/terminal.js");
const { ProcessTerminal } = await import(pathToFileURL(modulePath).href);

for (const code of [undefined, "EACCES", "EPERM", "EINVAL"]) {
  test(`startup resize signal: ${code ?? "success"}`, (t) => {
    const terminal = new ProcessTerminal();
    const fault = code ? Object.assign(new Error(code), { code }) : undefined;
    const signals = [];
    const kill = t.mock.method(process, "kill", (pid, signal) => {
      signals.push([pid, signal]);
      if (fault) throw fault;
      return true;
    });
    t.mock.method(process.stdin, "setEncoding", () => process.stdin);
    t.mock.method(process.stdin, "resume", () => process.stdin);
    if (process.stdin.setRawMode) t.mock.method(process.stdin, "setRawMode", () => process.stdin);
    t.mock.method(process.stdout, "write", () => true);
    let continued = false;
    t.mock.method(terminal, "enableWindowsVTInput", () => {});
    t.mock.method(terminal, "queryAndEnableKittyProtocol", () => { continued = true; });
    const resize = () => {};
    try {
      if (code === "EINVAL") {
        assert.throws(() => terminal.start(() => {}, resize), (error) => error === fault);
        assert.equal(continued, false);
      } else {
        terminal.start(() => {}, resize);
        assert.equal(continued, true);
      }
      assert.deepEqual(signals, [[process.pid, "SIGWINCH"]]);
      assert.ok(process.stdout.listeners("resize").includes(resize));
      assert.equal(kill.mock.callCount(), 1);
    } finally {
      process.stdout.removeListener("resize", resize);
    }
  });
}
