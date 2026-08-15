import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalInventory, createApplyBridgeCommand, createToken, parseArguments, readBrowserWebSocketEndpoint, validateLoopbackCdp, validatePlanToken } from "../extension/teal-eval-bulk-cli.mjs";

const inventory = canonicalInventory([
  { filename: "b.txt", sha256: "b".repeat(64), sizeText: "2 B" },
  { filename: "a.txt", sha256: "a".repeat(64), sizeText: "1 B" }
]);
assert.deepEqual(inventory.map((row) => row.filename), ["a.txt", "b.txt"]);
assert.throws(() => canonicalInventory([{ filename: "a.txt" }]), /invalid inventory row/i);

assert.equal(validateLoopbackCdp("http://127.0.0.1:9222").hostname, "127.0.0.1");
assert.throws(() => validateLoopbackCdp("http://192.168.1.2:9222"), /loopback/i);
assert.throws(() => parseArguments(["--cdp", "http://127.0.0.1:9222", "--issue", "TAB-TEST", "unknown"]), /Use one/i);
assert.equal(parseArguments(["--browser", "chrome", "--issue", "TAB-TEST", "status"]).browser, "chrome");
assert.throws(() => parseArguments(["--browser", "firefox", "--issue", "TAB-TEST", "status"]), /chrome or edge/i);
assert.throws(() => parseArguments(["--browser", "chrome", "--cdp", "http://127.0.0.1:9222", "--issue", "TAB-TEST", "status"]), /exactly one connection option/i);

const testUserDataDir = await mkdtemp(join(tmpdir(), "teal-active-port-"));
try {
  await writeFile(join(testUserDataDir, "DevToolsActivePort"), "43123\n/devtools/browser/test-session_1\n", "utf8");
  assert.equal(await readBrowserWebSocketEndpoint("chrome", testUserDataDir), "ws://127.0.0.1:43123/devtools/browser/test-session_1");
  await writeFile(join(testUserDataDir, "DevToolsActivePort"), "43123\nhttp://outside.example/\n", "utf8");
  await assert.rejects(() => readBrowserWebSocketEndpoint("chrome", testUserDataDir), /invalid/i);
} finally {
  await rm(testUserDataDir, { recursive: true, force: true });
}

const now = 10_000;
const state = { version: 1, tokens: {} };
const token = createToken(state, {
  issueIdentifier: "TAB-TEST",
  operation: "delete",
  targetId: "target-1",
  requestedNames: ["a.txt"],
  bridgeAuthorizationId: "11111111-1111-4111-8111-111111111111",
  inventory,
  expiresAt: now + 500,
  consumed: false
});
assert.match(token, /^[A-Za-z0-9_-]+$/);
validatePlanToken(state.tokens[token], { issueIdentifier: "TAB-TEST", operation: "delete", targetId: "target-1", now });
assert.throws(() => validatePlanToken(state.tokens[token], { issueIdentifier: "TAB-TEST", operation: "delete", targetId: "target-1", now: now + 501 }), /expired/i);
state.tokens[token].expiresAt = now + 500;
state.tokens[token].consumed = true;
assert.throws(() => validatePlanToken(state.tokens[token], { issueIdentifier: "TAB-TEST", operation: "delete", targetId: "target-1", now }), /already used/i);
state.tokens[token].consumed = false;
assert.throws(() => validatePlanToken(state.tokens[token], { issueIdentifier: "TAB-TEST", operation: "delete", targetId: "target-2", now }), /different target/i);
assert.deepEqual(createApplyBridgeCommand("apply-delete", state.tokens[token]), {
  command: "apply-delete",
  names: ["a.txt"],
  authorizationId: "11111111-1111-4111-8111-111111111111"
});
assert.throws(() => createApplyBridgeCommand("apply-delete", { ...state.tokens[token], bridgeAuthorizationId: "bad" }), /authorization/i);

console.log("v0.9 CLI token and inventory tests passed");
