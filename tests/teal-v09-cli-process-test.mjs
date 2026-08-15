import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("extension", "teal-eval-bulk-cli.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

const missing = run(["status"]);
assert.equal(missing.status, 2);
assert.ok(missing.stderr.includes("--issue"));
assert.equal(missing.stdout.trim().split("\n").length, 1);
assert.equal(JSON.parse(missing.stdout).ok, false);

const missingConnection = run(["--issue", "TAB-TEST", "status"]);
assert.equal(missingConnection.status, 2);
assert.ok(missingConnection.stderr.includes("connection option"));
assert.equal(JSON.parse(missingConnection.stdout).ok, false);

const remote = run(["--cdp", "http://192.168.1.2:9222", "--issue", "TAB-TEST", "status"]);
assert.equal(remote.status, 3);
assert.ok(remote.stderr.includes("loopback"));
assert.equal(remote.stdout.trim().split("\n").length, 1);
assert.equal(JSON.parse(remote.stdout).ok, false);

const wrongBrowser = run(["--browser", "firefox", "--issue", "TAB-TEST", "status"]);
assert.equal(wrongBrowser.status, 2);
assert.ok(wrongBrowser.stderr.includes("chrome or edge"));
assert.equal(JSON.parse(wrongBrowser.stdout).ok, false);

console.log("v0.9 CLI JSON, stderr, and exit tests passed");
