import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  CdpTransportError,
  applyPlan,
  classifyCommandResult,
  createApplyBridgeCommand,
  parseArguments,
  validatePlanConnection,
  validatePlanToken
} from "../extension/teal-eval-bulk-cli.mjs";
import {
  McpRpcError,
  McpStdioSession,
  McpToolError,
  PERSISTENT_BRIDGE_EXTENSION_VERSION,
  PersistentBridgeClient,
  decodeTerminalMarker
} from "../extension/persistent-mcp-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(root, "extension", "teal-eval-bulk-cli.mjs");
const fakeProxyPath = fileURLToPath(new URL("./fake-persistent-proxy.mjs", import.meta.url));
const defaultRows = [
  { filename: "existing-alpha.txt", sha256: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8", sizeText: "5 B" },
  { filename: "existing-beta.csv", sha256: "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753", sizeText: "4 B" },
  { filename: "existing-gamma.json", sha256: "be9d587defa1f0c09ef49eb17e206983a5f8f8289e4281860bd0ee5a19592c67", sizeText: "5 B" },
  { filename: "existing-delta.md", sha256: "4f4a9410ffcdf895c4adb880659e9b5c0dd1f23a30790684340b3eaacb045398", sizeText: "5 B" }
];

async function runProcess(command, args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function runCli(statePath, args, issueIdentifier = "TAB-TEST", env = {}) {
  return runProcess(process.execPath, [
    cliPath,
    "--persistent-bridge", fakeProxyPath,
    "--issue", issueIdentifier,
    "--state", statePath,
    ...args
  ], { TEAL_FAKE_MCP_STATE: `${statePath}.fake`, ...env });
}

function parseOnlyJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, received ${lines.length}`);
  return JSON.parse(lines[0]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeFakeState(statePath, value) {
  await writeFile(`${statePath}.fake`, JSON.stringify(value), "utf8");
}

function assertActionDiscipline(calls) {
  const sessions = new Map();
  for (const call of calls) {
    const group = sessions.get(call.session) || [];
    group.push(call.name);
    sessions.set(call.session, group);
  }
  assert.ok(sessions.size > 0);
  for (const names of sessions.values()) {
    assert.equal(names.length, 3, `session used an unexpected action count: ${names.join(",")}`);
    assert.deepEqual(names.slice(0, 2), ["list_pages", "select_page"]);
  }
}

function assertNoArbitraryBrowserCalls(calls) {
  const forbidden = new Set([
    "allow_remote_debugging", "click", "close_page", "drag", "emulate", "evaluate_script", "fill_form",
    "get_console_message", "get_network_request", "handle_dialog", "hover", "lighthouse_audit",
    "list_console_messages", "list_network_requests", "navigate_page", "new_page", "performance_analyze_insight",
    "performance_start_trace", "performance_stop_trace", "press_key", "resize_page", "take_heapsnapshot",
    "take_screenshot", "type_text"
  ]);
  assert.deepEqual(calls.filter((call) => forbidden.has(call.name)), []);
}

function commandFromFill(call) {
  return JSON.parse(call.args.value).command;
}

test("parser accepts download commands and rejects malformed download usage", () => {
  const prefix = ["--persistent-bridge", fakeProxyPath, "--issue", "tab-test"];
  const plan = parseArguments([...prefix, "plan-download", "a.txt", "b.csv"]);
  assert.equal(plan.command, "plan-download");
  assert.deepEqual(plan.operands, ["a.txt", "b.csv"]);
  assert.equal(plan.issueIdentifier, "TAB-TEST");
  const apply = parseArguments([...prefix, "apply-download", "a-valid-plan-token"]);
  assert.equal(apply.command, "apply-download");
  assert.deepEqual(apply.operands, ["a-valid-plan-token"]);
  assert.throws(() => parseArguments([...prefix, "plan-download"]), /requires at least one|filename/u);
  assert.throws(() => parseArguments([...prefix, "apply-download"]), /exactly one|plan token/u);
  assert.throws(() => parseArguments([...prefix, "apply-download", "one", "two"]), /exactly one|plan token/u);
  assert.throws(() => parseArguments([...prefix, "status", "unexpected"]), /does not accept|operand|usage/u);
  assert.throws(
    () => parseArguments(["--persistent-bridge", "relative-proxy.mjs", "--issue", "tab-test", "status"]),
    /absolute/u
  );
  assert.throws(() => new PersistentBridgeClient("relative-proxy.mjs", "TAB-TEST"), /absolute/u);
});

test("persistent bridge wait parsing is canonical, bounded, unique, and persistent-only", () => {
  const prefix = ["--persistent-bridge", fakeProxyPath, "--issue", "tab-test"];
  assert.equal(parseArguments([...prefix, "status"]).bridgeWaitMs, 120_000);
  assert.equal(parseArguments([...prefix, "--bridge-wait-seconds", "1", "status"]).bridgeWaitMs, 1_000);
  assert.equal(parseArguments([...prefix, "--bridge-wait-seconds", "300", "status"]).bridgeWaitMs, 300_000);
  for (const value of ["0", "301", "01", "1.0", "1e2", "0x10", "+1", "-1", " 1", "1 ", "１２"]) {
    assert.throws(
      () => parseArguments([...prefix, "--bridge-wait-seconds", value, "status"]),
      /bridge-wait-seconds.*canonical integer|bridge-wait-seconds.*1 through 300/u,
      value
    );
  }
  assert.throws(
    () => parseArguments([...prefix, "status", "--bridge-wait-seconds"]),
    /Missing value for --bridge-wait-seconds/u
  );
  assert.throws(
    () => parseArguments([...prefix, "--bridge-wait-seconds", "1", "--bridge-wait-seconds", "2", "status"]),
    /must not be repeated/u
  );
  assert.throws(
    () => parseArguments(["--cdp", "http://127.0.0.1:9222", "--bridge-wait-seconds", "1", "--issue", "TAB-TEST", "status"]),
    /only with --persistent-bridge/u
  );
  assert.throws(
    () => parseArguments(["--browser", "chrome", "--bridge-wait-seconds", "1", "--issue", "TAB-TEST", "status"]),
    /only with --persistent-bridge/u
  );
  assert.doesNotThrow(() => new PersistentBridgeClient(fakeProxyPath, "TAB-TEST", { leaseWaitMs: 1_000 }));
  assert.doesNotThrow(() => new PersistentBridgeClient(fakeProxyPath, "TAB-TEST", { leaseWaitMs: 300_000 }));
  for (const value of [999, 300_001, 1_000.5, "1000"]) {
    assert.throws(() => new PersistentBridgeClient(fakeProxyPath, "TAB-TEST", { leaseWaitMs: value }), /1000 through 300000/u);
    assert.throws(() => new McpStdioSession(fakeProxyPath, { leaseWaitMs: value }), /1000 through 300000/u);
  }
});

test("persistent tool sessions budget queue wait only for list_pages and keep one session", async () => {
  const client = new PersistentBridgeClient(fakeProxyPath, "TAB-TEST", { leaseWaitMs: 12_000 });
  const calls = [];
  const session = {
    async callTool(name, args, timeoutMs) {
      calls.push({ name, args, timeoutMs });
      if (name === "list_pages") {
        return { structuredContent: { pages: [{ id: 7, title: "TAB-TEST local fixture", url: "http://127.0.0.1:8769/issue/TAB-TEST" }] } };
      }
      return { structuredContent: {} };
    }
  };
  client.withSession = async (callback) => callback(session);
  await client.performTool("take_snapshot", { verbose: false }, 70_000);
  assert.deepEqual(calls, [
    { name: "list_pages", args: {}, timeoutMs: 57_000 },
    { name: "select_page", args: { pageId: 7, bringToFront: false }, timeoutMs: 45_000 },
    { name: "take_snapshot", args: { verbose: false }, timeoutMs: 70_000 }
  ]);
});

test("proved pre-dispatch lease failures bypass apply confirmation but ambiguous failures do not", async () => {
  for (const status of ["lease_busy", "held_unknown"]) {
    const client = new PersistentBridgeClient(fakeProxyPath, "TAB-TEST");
    client.targetUrl = "http://127.0.0.1:8769/issue/TAB-TEST";
    client.resolveControlUid = async () => "command-uid";
    const proved = new McpToolError("The lease wait expired.", { status, data: { dispatched: false } });
    client.performTool = async () => { throw proved; };
    let confirmations = 0;
    client.confirmDispatchAfterIndeterminate = async () => { confirmations += 1; };
    await assert.rejects(client.callBridge({ command: "apply-delete" }), (error) => error === proved && error.indeterminate !== true);
    assert.equal(confirmations, 0);
  }

  const ambiguousClient = new PersistentBridgeClient(fakeProxyPath, "TAB-TEST");
  ambiguousClient.targetUrl = "http://127.0.0.1:8769/issue/TAB-TEST";
  ambiguousClient.resolveControlUid = async () => "command-uid";
  ambiguousClient.performTool = async () => {
    throw new McpToolError("The lease state is unclear.", { status: "lease_busy", data: {} });
  };
  let ambiguousConfirmations = 0;
  ambiguousClient.confirmDispatchAfterIndeterminate = async () => {
    ambiguousConfirmations += 1;
    throw new Error("No acknowledgement was available.");
  };
  await assert.rejects(
    ambiguousClient.callBridge({ command: "apply-delete" }),
    (error) => error.indeterminate === true && /apply dispatch is indeterminate/u.test(error.message)
  );
  assert.equal(ambiguousConfirmations, 1);
});

class FakeOpenSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
  }
}

test("direct CDP rejects pending requests on socket loss and request timeout", async () => {
  const closedSocket = new FakeOpenSocket();
  const closedClient = new CdpClient(closedSocket);
  const interrupted = closedClient.request("Runtime.callFunctionOn", {}, null, 1_000);
  assert.equal(closedSocket.sent.length, 1);
  closedSocket.readyState = 3;
  closedSocket.dispatchEvent(new Event("close"));
  await assert.rejects(
    interrupted,
    (error) => error instanceof CdpTransportError
      && error.transport === true
      && error.requestDispatched === true
      && error.method === "Runtime.callFunctionOn"
  );
  assert.equal(closedClient.pending.size, 0);
  closedClient.close();

  const timedSocket = new FakeOpenSocket();
  const timedClient = new CdpClient(timedSocket);
  await assert.rejects(
    timedClient.request("Runtime.callFunctionOn", {}, null, 10),
    (error) => error instanceof CdpTransportError
      && error.timeout === true
      && error.requestDispatched === true
  );
  assert.equal(timedClient.pending.size, 0);
  timedClient.close();

  const protocolSocket = new FakeOpenSocket();
  const protocolClient = new CdpClient(protocolSocket);
  const protocolFailure = protocolClient.request("Runtime.callFunctionOn", {}, null, 1_000);
  protocolSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, error: { code: -32000, message: "evaluation failed" } }) }));
  await assert.rejects(protocolFailure, (error) => error.requestDispatched === true && error.method === "Runtime.callFunctionOn");
  protocolClient.close();
});

test("direct apply-download socket loss is indeterminate, one-use, and not retried", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-direct-loss-"));
  try {
    const statePath = join(temp, "tokens.json");
    const token = "direct-test-token";
    const now = Date.now();
    const targetUrl = "http://127.0.0.1:8769/issue/TAB-TEST";
    const record = {
      issueIdentifier: "TAB-TEST",
      operation: "download",
      targetId: "target-1",
      targetUrl,
      targetTitle: "TAB-TEST local fixture",
      connectionMode: "direct",
      bridgeDocumentId: "",
      requestedNames: [defaultRows[0].filename],
      actionableNames: [defaultRows[0].filename],
      skipped: [],
      bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      inventory: [defaultRows[0]],
      issuedAt: now,
      expiresAt: now + 60_000,
      consumed: false
    };
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");

    let applyDispatches = 0;
    let applyTimeoutMs = 0;
    const client = {
      mode: "direct",
      targetId: record.targetId,
      targetUrl,
      targetTitle: record.targetTitle,
      documentId: "",
      sessionId: null,
      async request(method, params, _sessionId, timeoutMs) {
        assert.equal(method, "Runtime.callFunctionOn");
        const command = params.arguments[0].value;
        if (command.command === "list") {
          return { result: { value: { ok: true, inventory: record.inventory } } };
        }
        assert.equal(command.command, "apply-download");
        applyDispatches += 1;
        applyTimeoutMs = timeoutMs;
        throw new CdpTransportError("The local CDP WebSocket closed.", {
          requestDispatched: true,
          method
        });
      }
    };
    const cli = {
      command: "apply-download",
      operands: [token],
      issueIdentifier: "TAB-TEST",
      statePath
    };

    const result = await applyPlan(cli, client, 99);
    assert.equal(applyDispatches, 1);
    assert.ok(applyTimeoutMs > 2 * 60 * 60 * 1_000);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.remaining, record.actionableNames);
    assert.match(result.error, /indeterminate|may still be running/u);

    const classified = classifyCommandResult(cli.command, cli.issueIdentifier, result);
    assert.equal(classified.exitCode, 4);
    assert.equal(classified.output.ok, false);
    assert.equal(classified.output.indeterminate, true);
    assert.equal(classified.output.tokenConsumed, true);
    assert.equal((await readJson(statePath)).tokens[token].consumed, true);

    await assert.rejects(() => applyPlan(cli, client, 99), /already used/u);
    assert.equal(applyDispatches, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("plain background apply-download uncertainty is structured and not retried", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-background-loss-"));
  try {
    const statePath = join(temp, "tokens.json");
    const token = "background-loss-token";
    const now = Date.now();
    const targetUrl = "http://127.0.0.1:8769/issue/TAB-TEST";
    const skipped = [{ name: "missing.txt", reason: "not staged" }];
    const record = {
      issueIdentifier: "TAB-TEST",
      operation: "download",
      targetId: "target-2",
      targetUrl,
      targetTitle: "TAB-TEST local fixture",
      connectionMode: "direct",
      bridgeDocumentId: "",
      requestedNames: [defaultRows[0].filename, "missing.txt"],
      actionableNames: [defaultRows[0].filename],
      skipped,
      bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      inventory: [defaultRows[0]],
      issuedAt: now,
      expiresAt: now + 60_000,
      consumed: false
    };
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");

    let applyDispatches = 0;
    const client = {
      mode: "direct",
      targetId: record.targetId,
      targetUrl,
      targetTitle: record.targetTitle,
      documentId: "",
      sessionId: null,
      async request(_method, params) {
        const command = params.arguments[0].value;
        if (command.command === "list") return { result: { value: { ok: true, inventory: record.inventory } } };
        applyDispatches += 1;
        return {
          result: {
            value: {
              ok: false,
              indeterminate: true,
              error: "The apply-download response channel failed after dispatch.",
              archiveFilename: "TAB-TEST-staged-files-2026-08-16.zip",
              downloadId: 88
            }
          }
        };
      }
    };
    const cli = { command: "apply-download", operands: [token], issueIdentifier: "TAB-TEST", statePath };

    const result = await applyPlan(cli, client, 101);
    assert.equal(applyDispatches, 1);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.operation, "download");
    assert.deepEqual(result.requestedNames, record.requestedNames);
    assert.deepEqual(result.actionableNames, record.actionableNames);
    assert.deepEqual(result.skipped, skipped);
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.remaining, record.actionableNames);
    assert.equal(result.archiveFilename, "TAB-TEST-staged-files-2026-08-16.zip");
    assert.equal(result.downloadId, 88);
    assert.equal(result.token, token);
    assert.equal(result.tokenConsumed, true);
    const classified = classifyCommandResult(cli.command, cli.issueIdentifier, result);
    assert.equal(classified.exitCode, 4);
    assert.equal(classified.output.ok, false);

    await assert.rejects(() => applyPlan(cli, client, 101), /already used/u);
    assert.equal(applyDispatches, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("download tokens bind issue, tab, URL, title, generation, and connection mode", () => {
  const now = 10_000;
  const record = {
    issueIdentifier: "TAB-TEST",
    operation: "download",
    targetId: "7",
    targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
    targetTitle: "TAB-TEST local fixture",
    connectionMode: "persistent",
    bridgeDocumentId: "11111111-2222-4333-8444-555555555555",
    requestedNames: ["existing-alpha.txt"],
    bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    inventory: defaultRows,
    expiresAt: now + 1_000,
    consumed: false
  };
  const client = {
    targetId: "7",
    targetUrl: record.targetUrl,
    targetTitle: record.targetTitle,
    mode: "persistent",
    documentId: record.bridgeDocumentId
  };
  assert.doesNotThrow(() => validatePlanToken(record, { issueIdentifier: "TAB-TEST", operation: "download", targetId: 7, now }));
  assert.throws(() => validatePlanToken(record, { issueIdentifier: "OTHER", operation: "download", targetId: 7, now }), /different issue|operation/u);
  assert.throws(() => validatePlanToken(record, { issueIdentifier: "TAB-TEST", operation: "delete", targetId: 7, now }), /different issue|operation/u);
  assert.throws(() => validatePlanToken(record, { issueIdentifier: "TAB-TEST", operation: "download", targetId: 8, now }), /different target|tab/u);
  assert.doesNotThrow(() => validatePlanConnection(record, client));
  assert.throws(() => validatePlanConnection(record, { ...client, targetUrl: `${client.targetUrl}/` }), /URL|page/u);
  assert.throws(() => validatePlanConnection(record, { ...client, targetTitle: "changed" }), /title/u);
  assert.throws(() => validatePlanConnection(record, { ...client, documentId: "new-generation" }), /refresh|generation/u);
  assert.throws(() => validatePlanConnection(record, { ...client, mode: "direct" }), /connection mode/u);
  assert.deepEqual(createApplyBridgeCommand("apply-download", record), {
    command: "apply-download",
    names: ["existing-alpha.txt"],
    authorizationId: record.bridgeAuthorizationId
  });
});

test("persistent download command and result envelopes use exact fields", () => {
  const requestId = "abcdefghijklmnop";
  const documentId = "11111111-2222-4333-8444-555555555555";
  const targetUrl = "http://127.0.0.1:8769/issue/TAB-TEST";
  const client = new PersistentBridgeClient(fakeProxyPath, "TAB-TEST");
  client.targetUrl = targetUrl;
  client.documentId = documentId;
  const command = {
    command: "apply-download",
    names: ["existing-alpha.txt"],
    authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  };
  const envelope = client.envelope(requestId, command);
  assert.deepEqual(Object.keys(envelope).sort(), ["command", "documentId", "protocolVersion", "requestId", "targetUrl"]);
  assert.deepEqual(Object.keys(envelope.command).sort(), ["authorizationId", "command", "names"]);

  const downloadResult = {
    ok: true,
    issueIdentifier: "TAB-TEST",
    operation: "download",
    requestedNames: ["existing-alpha.txt"],
    actionableNames: ["existing-alpha.txt"],
    succeeded: ["existing-alpha.txt"],
    skipped: [],
    failed: [],
    remaining: [],
    archiveFilename: "TAB-TEST-staged-files-2026-08-16.zip",
    downloadId: 42
  };
  const payload = {
    protocolVersion: 1,
    extensionVersion: PERSISTENT_BRIDGE_EXTENSION_VERSION,
    documentId,
    requestId,
    targetUrl,
    command: "apply-download",
    state: "completed",
    result: downloadResult
  };
  const marker = `TEAL_CLI_RESULT_${requestId}:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const decoded = decodeTerminalMarker({ structuredContent: { snapshot: { name: marker } } }, requestId, "apply-download", { documentId, targetUrl });
  assert.deepEqual(decoded.result, downloadResult);
  const extraPayload = { ...payload, navigation: "forbidden" };
  const extraMarker = `TEAL_CLI_RESULT_${requestId}:${Buffer.from(JSON.stringify(extraPayload)).toString("base64url")}`;
  assert.throws(
    () => decodeTerminalMarker({ structuredContent: { snapshot: { name: extraMarker } } }, requestId, "apply-download", { documentId, targetUrl }),
    /envelope was invalid/u
  );
});

test("MCP stdio framing remains fragmented and out of order safe", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-mcp-protocol-"));
  const fakeState = join(temp, "fake.json");
  const prior = process.env.TEAL_FAKE_MCP_STATE;
  process.env.TEAL_FAKE_MCP_STATE = fakeState;
  try {
    const session = await McpStdioSession.open(fakeProxyPath);
    const [slow, fast] = await Promise.all([
      session.request("test/echo", { value: "slow", delay: 20 }),
      session.request("test/echo", { value: "fast", delay: 1 })
    ]);
    assert.equal(slow.value, "slow");
    assert.equal(fast.value, "fast");
    await session.close();
  } finally {
    if (prior === undefined) delete process.env.TEAL_FAKE_MCP_STATE;
    else process.env.TEAL_FAKE_MCP_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
});

test("persistent proxy spawn arguments are exact and carry the validated wait", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-proxy-argv-"));
  try {
    const statePath = join(temp, "tokens.json");
    const run = await runCli(statePath, ["--bridge-wait-seconds", "7", "status"]);
    assert.equal(run.code, 0, run.stderr);
    const fake = await readJson(`${statePath}.fake`);
    assert.ok(fake.calls.length > 0);
    assert.equal(fake.calls.every((call) => call.leaseWaitMs === 7_000), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("persistent initialize rejects an old or changed gateway before browser dispatch", { concurrency: false }, async () => {
  for (const [env, expected] of [
    [{ TEAL_FAKE_SERVER_NAME: "changed-gateway" }, /chrome-devtools-persistent-gateway 0\.1\.2/u],
    [{ TEAL_FAKE_SERVER_VERSION: "0.1.1" }, /chrome-devtools-persistent-gateway 0\.1\.2/u]
  ]) {
    const temp = await mkdtemp(join(tmpdir(), "teal-gateway-identity-"));
    try {
      const statePath = join(temp, "tokens.json");
      const run = await runCli(statePath, ["--bridge-wait-seconds", "1", "status"], "TAB-TEST", env);
      assert.equal(run.code, 3, run.stderr);
      const result = parseOnlyJson(run.stdout);
      assert.equal(result.errorKind, "proxy_lifecycle");
      assert.match(result.error, expected);
      await assert.rejects(readFile(`${statePath}.fake`, "utf8"), (error) => error?.code === "ENOENT");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("MCP JSON-RPC and tool errors preserve sanitized structured fields", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-mcp-errors-"));
  const fakeState = join(temp, "fake.json");
  const prior = process.env.TEAL_FAKE_MCP_STATE;
  process.env.TEAL_FAKE_MCP_STATE = fakeState;
  try {
    const session = await McpStdioSession.open(fakeProxyPath);
    await assert.rejects(
      session.request("test/rpc-error", {}),
      (error) => error instanceof McpRpcError
        && error.rpcCode === -32603
        && error.rpcMessage.includes("[url]")
        && !error.rpcMessage.includes("private.example")
        && error.status === "custom_failure"
        && error.data.secretToken === "[redacted]"
        && !JSON.stringify(error.data).includes("must-not-leak")
    );
    const toolError = new McpToolError("failed at https://private.example/path", {
      status: "lease_busy",
      data: { owner: "unknown", owner_pid: 4321, authorizationToken: "must-not-leak", commandLine: "node proxy --token private", pageData: "private-page-data" }
    });
    assert.equal(toolError.status, "lease_busy");
    assert.equal(toolError.data.owner, "unknown");
    assert.equal(toolError.data.owner_pid, 4321);
    assert.equal(toolError.data.authorizationToken, "[redacted]");
    assert.equal(toolError.data.commandLine, "[redacted]");
    assert.equal(toolError.data.pageData, "[redacted]");
    assert.doesNotMatch(toolError.message, /private\.example/u);
    await session.close();
  } finally {
    if (prior === undefined) delete process.env.TEAL_FAKE_MCP_STATE;
    else process.env.TEAL_FAKE_MCP_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
});

test("MCP child shutdown waits for SIGTERM exit and stays bounded when the child does not exit", async () => {
  class FakeChild extends EventEmitter {
    constructor({ exitsAfterSignal }) {
      super();
      this.exitCode = null;
      this.signalCode = null;
      this.exitsAfterSignal = exitsAfterSignal;
      this.stdin = { destroyed: false, end() {} };
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      if (this.exitsAfterSignal) {
        setTimeout(() => {
          this.signalCode = signal;
          this.emit("exit", null, signal);
        }, 2);
      }
      return true;
    }
  }

  const exitingSession = new McpStdioSession("unused", { shutdownGraceMs: 5, shutdownTermMs: 20 });
  const exitingChild = new FakeChild({ exitsAfterSignal: true });
  exitingSession.child = exitingChild;
  const exited = await exitingSession.close();
  assert.deepEqual(exitingChild.signals, ["SIGTERM"]);
  assert.deepEqual(exited, { exited: true, signalSent: true });

  const stuckSession = new McpStdioSession("unused", { shutdownGraceMs: 5, shutdownTermMs: 5 });
  const stuckChild = new FakeChild({ exitsAfterSignal: false });
  stuckSession.child = stuckChild;
  const startedAt = Date.now();
  const stuck = await stuckSession.close();
  assert.equal(stuck.exited, false);
  assert.equal(stuck.signalSent, true);
  assert.equal(stuck.error.errorKind, "proxy_lifecycle");
  assert.ok(Date.now() - startedAt < 500);
});

test("persistent no-tab failure exits 3 and confirms zero mutation dispatch", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-no-tab-"));
  try {
    const statePath = join(temp, "tokens.json");
    await writeFakeState(statePath, { page: null });
    const run = await runCli(statePath, ["status"]);
    assert.equal(run.code, 3, run.stderr);
    const result = parseOnlyJson(run.stdout);
    assert.equal(result.errorKind, "no_matching_tab");
    assert.equal(result.transportResponded, true);
    assert.equal(result.mutationStarted, false);
    assert.match(result.error, /required allowed issue tab is not open/u);
    assert.match(result.error, /No mutation started/u);
    const fake = await readJson(`${statePath}.fake`);
    assert.deepEqual(fake.calls.map((call) => call.name), ["list_pages"]);
    assert.deepEqual(fake.commandEnvelopes, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply queue timeout exits 3 without indeterminate state, fill dispatch, confirmation, or replay", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-apply-queue-timeout-"));
  try {
    const statePath = join(temp, "tokens.json");
    const planRun = await runCli(statePath, ["--bridge-wait-seconds", "1", "plan-download", "existing-alpha.txt"]);
    assert.equal(planRun.code, 0, planRun.stderr);
    const plan = parseOnlyJson(planRun.stdout);
    const fakeBefore = await readJson(`${statePath}.fake`);
    fakeBefore.queueBusyBeforeApplyFill = true;
    await writeFakeState(statePath, fakeBefore);

    const applyRun = await runCli(statePath, ["--bridge-wait-seconds", "1", "apply-download", plan.token]);
    assert.equal(applyRun.code, 3, applyRun.stderr);
    const failed = parseOnlyJson(applyRun.stdout);
    assert.equal(failed.errorKind, "lease_busy");
    assert.equal(failed.bridgeStatus, "lease_busy");
    assert.equal(failed.dispatched, false);
    assert.equal(failed.errorData?.dispatched, false);
    assert.notEqual(failed.indeterminate, true);
    assert.equal(failed.exitCode, 3);

    const fakeAfter = await readJson(`${statePath}.fake`);
    assert.equal(fakeAfter.queueBusyEvents, 1);
    assert.equal(fakeAfter.commandEnvelopes.some((envelope) => envelope.command.command === "apply-download"), false);
    assert.equal(fakeAfter.calls.filter((call) => call.name === "fill" && commandFromFill(call).command === "apply-download").length, 0);
    assert.equal(fakeAfter.calls.at(-1)?.name, "list_pages");
    const timedOutSession = fakeAfter.calls.at(-1).session;
    assert.deepEqual(fakeAfter.chromeDispatches.filter((call) => call.session === timedOutSession), []);
    const tokenState = await readJson(statePath);
    assert.equal(tokenState.tokens[plan.token].consumed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("plan-download returns actionable and skipped names and saves one-use state", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-plan-"));
  try {
    const statePath = join(temp, "tokens.json");
    await writeFakeState(statePath, {
      inventory: [defaultRows[0], { ...defaultRows[0], sha256: "0".repeat(64) }, defaultRows[1]]
    });
    const run = await runCli(statePath, [
      "plan-download",
      "existing-alpha.txt",
      "existing-alpha.txt",
      "missing.txt",
      "existing-beta.csv"
    ]);
    assert.equal(run.code, 0, run.stderr);
    const result = parseOnlyJson(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.operation, "download");
    assert.deepEqual(result.actionableNames, ["existing-beta.csv"]);
    assert.deepEqual(result.skipped.map(({ name }) => name), ["existing-alpha.txt", "existing-alpha.txt", "missing.txt"]);
    assert.match(result.skipped[0].reason, /ambiguous/u);
    assert.match(result.skipped[1].reason, /duplicate/u);
    assert.match(result.skipped[2].reason, /not staged|missing/u);
    assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/u);

    const tokenState = await readJson(statePath);
    const saved = tokenState.tokens[result.token];
    assert.equal(saved.operation, "download");
    assert.equal(saved.issueIdentifier, "TAB-TEST");
    assert.equal(String(saved.targetId), "7");
    assert.equal(saved.targetUrl, "http://127.0.0.1:8769/issue/TAB-TEST");
    assert.equal(saved.targetTitle, "TAB-TEST local fixture");
    assert.equal(saved.connectionMode, "persistent");
    assert.equal(saved.bridgeDocumentId, "11111111-2222-4333-8444-555555555555");
    assert.equal(saved.consumed, false);

    const fake = await readJson(`${statePath}.fake`);
    assertActionDiscipline(fake.calls);
    assertNoArbitraryBrowserCalls(fake.calls);
    const planEnvelope = fake.commandEnvelopes.find((value) => value.command.command === "plan-download");
    assert.deepEqual(Object.keys(planEnvelope).sort(), ["command", "documentId", "protocolVersion", "requestId", "targetUrl"]);
    assert.deepEqual(Object.keys(planEnvelope.command).sort(), ["command", "names"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply-download returns a structured ZIP result and consumes its token once", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-apply-"));
  try {
    const statePath = join(temp, "tokens.json");
    const requested = defaultRows.map((row) => row.filename);
    const planRun = await runCli(statePath, ["plan-download", ...requested]);
    assert.equal(planRun.code, 0, planRun.stderr);
    const plan = parseOnlyJson(planRun.stdout);
    assert.deepEqual(plan.actionableNames, requested);

    const applyRun = await runCli(statePath, ["apply-download", plan.token]);
    assert.equal(applyRun.code, 0, applyRun.stderr);
    const applied = parseOnlyJson(applyRun.stdout);
    assert.equal(applied.ok, true);
    assert.equal(applied.operation, "download");
    assert.deepEqual(applied.succeeded, requested);
    assert.deepEqual(applied.skipped, []);
    assert.deepEqual(applied.failed, []);
    assert.deepEqual(applied.remaining, []);
    assert.match(applied.archiveFilename, /^TAB-TEST-staged-files-\d{4}-\d{2}-\d{2}\.zip$/u);
    assert.equal(applied.downloadId, 42);
    assert.equal(applied.token, plan.token);
    assert.equal(applied.tokenConsumed, true);

    const secondApply = await runCli(statePath, ["apply-download", plan.token]);
    assert.equal(secondApply.code, 4);
    const rejected = parseOnlyJson(secondApply.stdout);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /already used/u);

    const fake = await readJson(`${statePath}.fake`);
    const applyFills = fake.calls
      .filter((call) => call.name === "fill")
      .filter((call) => commandFromFill(call).command === "apply-download");
    assert.equal(applyFills.length, 1);
    const applyEnvelope = fake.commandEnvelopes.find((value) => value.command.command === "apply-download");
    assert.deepEqual(Object.keys(applyEnvelope.command).sort(), ["authorizationId", "command", "names"]);
    assertActionDiscipline(fake.calls);
    assertNoArbitraryBrowserCalls(fake.calls);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("inventory drift blocks apply-download before token consumption or dispatch", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-drift-"));
  try {
    const statePath = join(temp, "tokens.json");
    const planRun = await runCli(statePath, ["plan-download", "existing-gamma.json"]);
    assert.equal(planRun.code, 0, planRun.stderr);
    const plan = parseOnlyJson(planRun.stdout);
    const fakeBefore = await readJson(`${statePath}.fake`);
    fakeBefore.inventory.push({ filename: "new-after-plan.txt", sha256: "9".repeat(64), sizeText: "9 B" });
    await writeFakeState(statePath, fakeBefore);

    const applyRun = await runCli(statePath, ["apply-download", plan.token]);
    assert.equal(applyRun.code, 4);
    const rejected = parseOnlyJson(applyRun.stdout);
    assert.match(rejected.error, /inventory changed/u);
    const tokenState = await readJson(statePath);
    assert.equal(tokenState.tokens[plan.token].consumed, false);
    const fakeAfter = await readJson(`${statePath}.fake`);
    assert.equal(fakeAfter.commandEnvelopes.some((value) => value.command.command === "apply-download"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("uncertain apply-download reports indeterminate and is never retried", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-indeterminate-"));
  try {
    const statePath = join(temp, "tokens.json");
    const planRun = await runCli(statePath, ["plan-download", "existing-delta.md"]);
    assert.equal(planRun.code, 0, planRun.stderr);
    const plan = parseOnlyJson(planRun.stdout);
    const fakeBefore = await readJson(`${statePath}.fake`);
    fakeBefore.indeterminateApplyDownload = true;
    await writeFakeState(statePath, fakeBefore);

    const applyRun = await runCli(statePath, ["apply-download", plan.token]);
    assert.equal(applyRun.code, 4);
    const uncertain = parseOnlyJson(applyRun.stdout);
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.indeterminate, true);
    assert.match(uncertain.error, /indeterminate|may still be running/u);

    const fakeAfter = await readJson(`${statePath}.fake`);
    assert.equal(fakeAfter.uncertainApplyDownloadDispatches, 1);
    assert.equal(fakeAfter.commandEnvelopes.filter((value) => value.command.command === "apply-download").length, 1);
    assert.equal(fakeAfter.calls.filter((call) => call.name === "click" || call.name === "handle_dialog").length, 0);
    assertActionDiscipline(fakeAfter.calls);
    assertNoArbitraryBrowserCalls(fakeAfter.calls);
    const tokenState = await readJson(statePath);
    assert.equal(tokenState.tokens[plan.token].consumed, true);

    const secondApply = await runCli(statePath, ["apply-download", plan.token]);
    assert.equal(secondApply.code, 4);
    assert.match(parseOnlyJson(secondApply.stdout).error, /already used/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("persistent status, upload, and delete behavior remains covered", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-download-regression-"));
  try {
    const statePath = join(temp, "tokens.json");
    const statusRun = await runCli(statePath, ["status"]);
    assert.equal(statusRun.code, 0, statusRun.stderr);
    assert.equal(parseOnlyJson(statusRun.stdout).command, "status");

    const uploadPath = join(temp, "new upload.txt");
    await writeFile(uploadPath, "new", "utf8");
    const uploadPlanRun = await runCli(statePath, ["plan-upload", uploadPath]);
    assert.equal(uploadPlanRun.code, 0, uploadPlanRun.stderr);
    const uploadPlan = parseOnlyJson(uploadPlanRun.stdout);
    assert.deepEqual(uploadPlan.actionableNames, [basename(uploadPath)]);
    const uploadApplyRun = await runCli(statePath, ["apply-upload", uploadPlan.token]);
    assert.equal(uploadApplyRun.code, 0, uploadApplyRun.stderr);
    assert.deepEqual(parseOnlyJson(uploadApplyRun.stdout).succeeded, [basename(uploadPath)]);

    const deletePlanRun = await runCli(statePath, ["plan-delete", "existing-beta.csv"]);
    assert.equal(deletePlanRun.code, 0, deletePlanRun.stderr);
    const deletePlan = parseOnlyJson(deletePlanRun.stdout);
    const deleteApplyRun = await runCli(statePath, ["apply-delete", deletePlan.token]);
    assert.equal(deleteApplyRun.code, 0, deleteApplyRun.stderr);
    const deleteApplied = parseOnlyJson(deleteApplyRun.stdout);
    assert.deepEqual(deleteApplied.succeeded, ["existing-beta.csv"]);
    assert.deepEqual(deleteApplied.inventoryBefore, deletePlan.inventory);
    assert.equal(deleteApplied.inventoryAfter.some((row) => row.filename === "existing-beta.csv"), false);
    assert.deepEqual(deleteApplied.inventory, deleteApplied.inventoryAfter);
    assert.equal(deleteApplied.replayAllowed, false);

    const fake = await readJson(`${statePath}.fake`);
    assertActionDiscipline(fake.calls);
    assertNoArbitraryBrowserCalls(fake.calls);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
