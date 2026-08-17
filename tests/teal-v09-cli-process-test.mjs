import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("extension", "teal-eval-bulk-cli.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

const missing = run(["status"]);
assert.equal(missing.status, 2);
assert.ok(missing.stderr.includes("--issue"));
assert.equal(missing.stdout.trim().split("\n").length, 1);
assert.equal(JSON.parse(missing.stdout).ok, false);
assert.equal(JSON.parse(missing.stdout).exitCode, missing.status);
assert.equal(JSON.parse(missing.stdout).exitMeaning, "usage error");

const missingConnection = run(["--issue", "TAB-TEST", "status"]);
assert.equal(missingConnection.status, 2);
assert.ok(missingConnection.stderr.includes("connection option"));
assert.equal(JSON.parse(missingConnection.stdout).ok, false);
assert.equal(JSON.parse(missingConnection.stdout).exitCode, missingConnection.status);

const remote = run(["--cdp", "http://192.168.1.2:9222", "--issue", "TAB-TEST", "status"]);
assert.equal(remote.status, 3);
assert.ok(remote.stderr.includes("loopback"));
assert.equal(remote.stdout.trim().split("\n").length, 1);
assert.equal(JSON.parse(remote.stdout).ok, false);
assert.equal(JSON.parse(remote.stdout).exitCode, remote.status);
assert.equal(JSON.parse(remote.stdout).exitMeaning, "connection error");

const wrongBrowser = run(["--browser", "firefox", "--issue", "TAB-TEST", "status"]);
assert.equal(wrongBrowser.status, 2);
assert.ok(wrongBrowser.stderr.includes("chrome or edge"));
assert.equal(JSON.parse(wrongBrowser.stdout).ok, false);
assert.equal(JSON.parse(wrongBrowser.stdout).exitCode, wrongBrowser.status);

const fakeProxy = resolve("tests", "fake-persistent-proxy.mjs");
const unknownRpc = run([
  "--persistent-bridge", fakeProxy,
  "--issue", "TAB-TEST",
  "status"
], {
  TEAL_FAKE_MCP_STATE: resolve("work", "fake-unknown-rpc-state.json"),
  TEAL_FAKE_RPC_MODE: "unknown_internal"
});
assert.equal(unknownRpc.status, 3);
assert.match(unknownRpc.stderr, /-32603/u);
assert.doesNotMatch(unknownRpc.stderr, /start-daemon\.ps1/u);
const unknownRpcJson = JSON.parse(unknownRpc.stdout);
assert.equal(unknownRpcJson.errorKind, "rpc_error");
assert.equal(unknownRpcJson.rpcCode, -32603);
assert.equal(unknownRpcJson.errorData.secretToken, "[redacted]");
assert.equal(unknownRpcJson.errorData.commandLine, "[redacted]");
assert.equal(unknownRpcJson.errorData.pageData, "[redacted]");
assert.doesNotMatch(JSON.stringify(unknownRpcJson), /must-not-leak|private\.example|private-page-data|node proxy/u);
assert.equal(unknownRpcJson.exitCode, unknownRpc.status);

const daemonDown = run([
  "--persistent-bridge", fakeProxy,
  "--issue", "TAB-TEST",
  "status"
], {
  TEAL_FAKE_MCP_STATE: resolve("work", "fake-daemon-down-state.json"),
  TEAL_FAKE_STARTUP_MODE: "daemon_absent"
});
assert.equal(daemonDown.status, 3);
assert.match(daemonDown.stderr, /daemon is absent/u);
assert.match(daemonDown.stderr, /status\.ps1/u);
assert.match(daemonDown.stderr, /start-daemon\.ps1/u);
assert.doesNotMatch(daemonDown.stderr, /runtime[\\/]runtime/u);
const daemonDownJson = JSON.parse(daemonDown.stdout);
assert.equal(daemonDownJson.errorKind, "daemon_absent");
assert.equal(daemonDownJson.bridgeStatus, "daemon_absent");
assert.equal(daemonDownJson.errorData.status, "daemon_absent");
assert.equal(daemonDownJson.errorData.startupExit, 17);
assert.doesNotMatch(JSON.stringify(daemonDownJson), /must-not-leak|private-page-data|node proxy/u);
assert.equal(daemonDownJson.exitCode, daemonDown.status);
assert.equal(daemonDownJson.exitMeaning, "connection error");

const ambiguousStartup = run([
  "--persistent-bridge", fakeProxy,
  "--issue", "TAB-TEST",
  "status"
], {
  TEAL_FAKE_MCP_STATE: resolve("work", "fake-ambiguous-startup-state.json"),
  TEAL_FAKE_STARTUP_MODE: "ambiguous_exit"
});
assert.equal(ambiguousStartup.status, 3);
const ambiguousStartupJson = JSON.parse(ambiguousStartup.stdout);
assert.equal(ambiguousStartupJson.errorKind, "proxy_lifecycle");
assert.doesNotMatch(ambiguousStartup.stderr, /start-daemon\.ps1/u);
assert.doesNotMatch(`${ambiguousStartup.stdout}${ambiguousStartup.stderr}`, /must-not-leak|private-page-data|node proxy/u);

console.log("v0.9 CLI JSON, stderr, and exit tests passed");
