#!/usr/bin/env node
import { basename } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const proxyArguments = process.argv.slice(2);
if (proxyArguments.length !== 3
  || proxyArguments[0] !== "chrome-devtools"
  || proxyArguments[1] !== "--lease-wait-ms"
  || !/^(?:0|[1-9][0-9]*)$/.test(proxyArguments[2])) {
  throw new Error("The fake persistent proxy received unexpected arguments.");
}
const leaseWaitMs = Number(proxyArguments[2]);
if (!Number.isInteger(leaseWaitMs) || leaseWaitMs < 750 || leaseWaitMs > 300_000) {
  throw new Error("The fake persistent proxy received an out-of-range lease wait.");
}

const statePath = process.env.TEAL_FAKE_MCP_STATE;
if (!statePath) throw new Error("TEAL_FAKE_MCP_STATE is required.");

if (process.env.TEAL_FAKE_STARTUP_MODE === "daemon_absent") {
  process.stderr.write("command line: node proxy --token must-not-leak\npage data: private-page-data\n");
  process.stderr.write('{"schema_version":1,"component":"chrome-devtools-persistent-gateway","status":"startup_failed","cause":"daemon_absent","retryable":true}\n');
  process.exit(17);
}
if (process.env.TEAL_FAKE_STARTUP_MODE === "ambiguous_exit") {
  process.stderr.write("command line: node proxy --token must-not-leak\npage data: private-page-data\n");
  process.exit(18);
}

const extensionVersion = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")).version;
const toolNames = [
  "allow_remote_debugging", "click", "close_page", "drag", "emulate", "evaluate_script", "fill", "fill_form",
  "get_console_message", "get_network_request", "handle_dialog", "hover", "lighthouse_audit", "list_console_messages",
  "list_network_requests", "list_pages", "navigate_page", "new_page", "performance_analyze_insight",
  "performance_start_trace", "performance_stop_trace", "press_key", "resize_page", "select_page", "take_heapsnapshot",
  "take_screenshot", "take_snapshot", "type_text", "upload_file", "wait_for"
];

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {})
});
const stringSchema = { type: "string" };
const booleanSchema = { type: "boolean" };
const numberSchema = { type: "number" };
const schemas = {
  list_pages: objectSchema(),
  select_page: objectSchema({ pageId: numberSchema, bringToFront: booleanSchema }, ["pageId"]),
  take_snapshot: objectSchema({ verbose: booleanSchema, filePath: stringSchema }),
  fill: objectSchema({ uid: stringSchema, value: stringSchema, includeSnapshot: booleanSchema }, ["uid", "value"]),
  upload_file: objectSchema({ uid: stringSchema, filePath: stringSchema, includeSnapshot: booleanSchema }, ["uid", "filePath"]),
  wait_for: objectSchema({ text: { type: "array", items: stringSchema }, timeout: { type: "integer" } }, ["text"])
};
const tools = toolNames.map((name) => ({ name, inputSchema: schemas[name] || objectSchema() }));

const HASHES = {
  "existing-alpha.txt": "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
  "existing-beta.csv": "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
  "existing-gamma.json": "be9d587defa1f0c09ef49eb17e206983a5f8f8289e4281860bd0ee5a19592c67",
  "existing-delta.md": "4f4a9410ffcdf895c4adb880659e9b5c0dd1f23a30790684340b3eaacb045398"
};

function defaultInventory() {
  return [
    { filename: "existing-alpha.txt", sha256: HASHES["existing-alpha.txt"], sizeText: "5 B" },
    { filename: "existing-beta.csv", sha256: HASHES["existing-beta.csv"], sizeText: "4 B" },
    { filename: "existing-gamma.json", sha256: HASHES["existing-gamma.json"], sizeText: "5 B" },
    { filename: "existing-delta.md", sha256: HASHES["existing-delta.md"], sizeText: "5 B" }
  ];
}

function initialState() {
  return {
    calls: [],
    chromeDispatches: [],
    commandEnvelopes: [],
    page: { id: 7, url: "http://127.0.0.1:8769/issue/TAB-TEST", title: "TAB-TEST local fixture" },
    documentId: "11111111-2222-4333-8444-555555555555",
    markers: [],
    uploadedFiles: [],
    inventory: defaultInventory(),
    authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    downloadId: 42,
    indeterminateApplyDownload: false
  };
}

function loadState() {
  if (!existsSync(statePath)) return initialState();
  return { ...initialState(), ...JSON.parse(readFileSync(statePath, "utf8")) };
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

let outputQueue = Promise.resolve();
function send(value) {
  const line = `${JSON.stringify(value)}\n`;
  outputQueue = outputQueue.then(async () => {
    const first = Math.max(1, Math.floor(line.length / 3));
    const second = Math.max(first + 1, Math.floor(line.length * 2 / 3));
    process.stdout.write(line.slice(0, first));
    await new Promise((resolve) => setTimeout(resolve, 1));
    process.stdout.write(line.slice(first, second));
    await new Promise((resolve) => setTimeout(resolve, 1));
    process.stdout.write(line.slice(second));
  });
}

function success(structuredContent, message = "ok") {
  return { content: [{ type: "text", text: message }], structuredContent };
}

function failure(message, status = "tool_failed", data = undefined) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { status, ...(data === undefined ? {} : { data }) },
    isError: true
  };
}

function snapshot(state) {
  return {
    id: "root",
    role: "RootWebArea",
    name: state.page.title,
    children: [
      { id: "upload-uid", role: "button", name: "Teal CLI persistent upload" },
      { id: "command-uid", role: "textbox", name: "Teal CLI persistent command" },
      ...state.markers.map((name, index) => ({ id: `marker-${index}`, role: "status", name }))
    ]
  };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateCommandShape(command) {
  const commandName = command?.command;
  if (["capabilities", "status", "list", "prepare-upload", "cancel-upload", "stop"].includes(commandName)) {
    return exactKeys(command, ["command"]);
  }
  if (["plan-upload", "plan-download", "plan-delete"].includes(commandName)) {
    return exactKeys(command, ["command", "names"]);
  }
  if (["apply-upload", "apply-download", "apply-delete"].includes(commandName)) {
    return exactKeys(command, ["command", "names", "authorizationId"]);
  }
  return false;
}

function classifyNames(inventory, requestedNames, missingReason = "not staged") {
  const used = new Set();
  const actionableNames = [];
  const skipped = [];
  for (const name of requestedNames) {
    if (used.has(name)) {
      skipped.push({ name, reason: "duplicate requested name" });
      continue;
    }
    used.add(name);
    const matches = inventory.filter((row) => row.filename === name);
    if (matches.length === 0) skipped.push({ name, reason: missingReason });
    else if (matches.length !== 1) skipped.push({ name, reason: "ambiguous staged row" });
    else actionableNames.push(name);
  }
  return { actionableNames, skipped };
}

function canonicalInventory(inventory) {
  return inventory.map((row) => ({ ...row })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
}

function bridgeResult(state, envelope) {
  const command = envelope.command;
  state.commandEnvelopes.push(envelope);
  let result;
  if (!validateCommandShape(command)) {
    result = { ok: false, error: "command fields were not exact" };
  } else if (command.command === "capabilities") {
    result = {
      ok: true,
      issueIdentifier: "TAB-TEST",
      persistentBridgeProtocolVersion: 1,
      extensionVersion,
      documentId: state.documentId,
      targetUrl: state.page.url
    };
  } else if (command.command === "status") {
    result = { ok: true, issueIdentifier: "TAB-TEST", busy: false, activeOperation: "" };
  } else if (command.command === "list") {
    result = { ok: true, issueIdentifier: "TAB-TEST", inventory: state.inventory };
  } else if (command.command === "prepare-upload") {
    state.uploadedFiles = [];
    result = { ok: true, issueIdentifier: "TAB-TEST", expiresAt: Date.now() + 300_000 };
  } else if (command.command === "cancel-upload") {
    state.uploadedFiles = [];
    result = { ok: true, issueIdentifier: "TAB-TEST", cancelled: true };
  } else if (command.command === "plan-upload") {
    const uploadedNames = state.uploadedFiles.map((filePath) => basename(filePath));
    const actionableNames = command.names.filter((name, index) => uploadedNames.includes(name) && command.names.indexOf(name) === index);
    result = {
      ok: true,
      issueIdentifier: "TAB-TEST",
      operation: "upload",
      requestedNames: command.names,
      actionableNames,
      skipped: command.names.filter((name) => !uploadedNames.includes(name)).map((name) => ({ name, reason: "not selected" })),
      inventory: state.inventory,
      authorizationId: state.authorizationId
    };
  } else if (command.command === "plan-download" || command.command === "plan-delete") {
    const operation = command.command === "plan-download" ? "download" : "delete";
    const classified = classifyNames(state.inventory, command.names);
    result = {
      ok: true,
      issueIdentifier: "TAB-TEST",
      operation,
      requestedNames: command.names,
      actionableNames: classified.actionableNames,
      skipped: classified.skipped,
      inventory: state.inventory,
      authorizationId: state.authorizationId
    };
  } else if (command.command === "apply-upload") {
    for (const name of command.names) {
      if (!state.inventory.some((row) => row.filename === name)) {
        state.inventory.push({ filename: name, sha256: "a".repeat(64), sizeText: "1 B" });
      }
    }
    result = { ok: true, issueIdentifier: "TAB-TEST", operation: "upload", succeeded: command.names, skipped: [], failed: [], remaining: [] };
  } else if (command.command === "apply-download") {
    const classified = classifyNames(state.inventory, command.names);
    result = {
      ok: true,
      issueIdentifier: "TAB-TEST",
      operation: "download",
      requestedNames: command.names,
      actionableNames: classified.actionableNames,
      succeeded: classified.actionableNames,
      skipped: classified.skipped,
      failed: [],
      remaining: [],
      archiveFilename: "TAB-TEST-staged-files-2026-08-16.zip",
      downloadId: state.downloadId
    };
  } else if (command.command === "apply-delete") {
    const inventoryBefore = canonicalInventory(state.inventory);
    const classified = classifyNames(state.inventory, command.names);
    state.inventory = state.inventory.filter((row) => !classified.actionableNames.includes(row.filename));
    const inventoryAfter = canonicalInventory(state.inventory);
    result = {
      ok: true,
      issueIdentifier: "TAB-TEST",
      operation: "delete",
      succeeded: classified.actionableNames,
      skipped: classified.skipped,
      failed: [],
      remaining: [],
      inventoryBefore,
      inventoryAfter,
      inventory: inventoryAfter,
      needsReadOnlyList: false,
      replayAllowed: false
    };
  } else if (command.command === "stop") {
    result = { ok: true, issueIdentifier: "TAB-TEST", stopped: false, activeOperation: "" };
  } else {
    result = { ok: false, error: "unsupported command" };
  }

  const payload = {
    protocolVersion: 1,
    extensionVersion,
    documentId: state.documentId,
    requestId: envelope.requestId,
    targetUrl: state.page.url,
    command: command.command,
    state: "completed",
    result
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  state.markers.push(`TEAL_CLI_ACK_${envelope.requestId}`);
  state.markers.push(`TEAL_CLI_RESULT_${envelope.requestId}`);
  state.markers.push(`TEAL_CLI_RESULT_${envelope.requestId}:${encoded}`);
}

const toolSequence = [];
async function callTool(name, args) {
  const state = loadState();
  state.calls.push({ session: process.pid, name, args, leaseWaitMs });
  saveState(state);
  if (name === "list_pages" && state.queueBusyNextListPages === true) {
    state.queueBusyNextListPages = false;
    state.queueBusyEvents = Number(state.queueBusyEvents || 0) + 1;
    saveState(state);
    return failure("The authenticated browser transport lease wait expired.", "lease_busy", {
      dispatched: false,
      automatic_retry_allowed: false,
      owner_pid: 4321
    });
  }
  if (toolSequence.length === 0 && name !== "list_pages") return failure("Call list_pages first.");
  if (toolSequence.length === 1 && name !== "select_page") return failure("Call select_page second.");
  if (toolSequence.length >= 2) return failure("One action is allowed per fake proxy session.");
  toolSequence.push(name);
  state.chromeDispatches.push({ session: process.pid, name });
  saveState(state);
  if (name === "list_pages") return success({ pages: state.page ? [state.page] : [] });
  if (name === "select_page") {
    if (args.pageId !== state.page.id || args.bringToFront !== false) return failure("The wrong page was selected.");
    return success({ pages: [{ ...state.page, selected: true }] });
  }
  return failure("unreachable");
}

async function actionTool(name, args) {
  const state = loadState();
  state.calls.push({ session: process.pid, name, args, leaseWaitMs });
  state.chromeDispatches.push({ session: process.pid, name });
  saveState(state);
  if (name === "take_snapshot") {
    const previousCommand = state.commandEnvelopes.at(-1)?.command?.command;
    if (state.queueBusyBeforeApplyFill === true && previousCommand === "list") {
      state.queueBusyBeforeApplyFill = false;
      state.queueBusyNextListPages = true;
      saveState(state);
    }
    return success({ snapshot: snapshot(state) });
  }
  if (name === "fill") {
    if (args.uid !== "command-uid" || typeof args.value !== "string") return failure("The command control was invalid.");
    const envelope = JSON.parse(args.value);
    if (state.indeterminateApplyDownload && envelope?.command?.command === "apply-download") {
      state.commandEnvelopes.push(envelope);
      state.uncertainApplyDownloadDispatches = Number(state.uncertainApplyDownloadDispatches || 0) + 1;
      saveState(state);
      return failure("The fake proxy lost the apply result after dispatch.", "indeterminate_mutating_call");
    }
    bridgeResult(state, envelope);
    saveState(state);
    return success({ message: "filled" });
  }
  if (name === "upload_file") {
    if (args.uid !== "upload-uid") return failure("The upload control was invalid.");
    state.uploadedFiles.push(args.filePath);
    saveState(state);
    return success({ message: "uploaded" });
  }
  if (name === "wait_for") {
    const found = args.text.some((text) => state.markers.includes(text));
    if (found) return success({ snapshot: snapshot(state) });
    if (state.indeterminateApplyDownload) return failure("The fake proxy intentionally withheld the apply acknowledgement.");
    return failure(`Timed out after waiting ${args.timeout || 0}ms`);
  }
  return failure(`The fake proxy does not implement ${name}.`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch { process.exit(9); }
    if (!Object.prototype.hasOwnProperty.call(request, "id")) continue;
    const respond = (result) => send({ jsonrpc: "2.0", id: request.id, result });
    const rpcMode = process.env.TEAL_FAKE_RPC_MODE || (process.env.TEAL_FAKE_DAEMON_DOWN === "1" ? "unknown_internal" : "");
    if (request.method === "initialize" && rpcMode === "unknown_internal") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fake internal failure at https://private.example/path", data: { note: "unknown", secretToken: "must-not-leak", commandLine: "node proxy --token private", pageData: "private-page-data" } } });
    } else if (request.method === "initialize" && rpcMode === "daemon_absent") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fake daemon unavailable", data: { status: "daemon_absent", detail: "The daemon named pipe is absent.", secretToken: "must-not-leak" } } });
    } else if (request.method === "initialize" && rpcMode === "lease_busy") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fake browser transport lease is busy", data: { status: "lease_busy", owner: null } } });
    } else if (request.method === "initialize") {
      respond({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: process.env.TEAL_FAKE_SERVER_NAME || "chrome-devtools-persistent-gateway",
          version: process.env.TEAL_FAKE_SERVER_VERSION || "0.1.3"
        }
      });
    } else if (request.method === "tools/list") {
      respond({ tools });
    } else if (request.method === "test/echo") {
      setTimeout(() => respond({ value: request.params.value }), request.params.delay);
    } else if (request.method === "test/rpc-error") {
      send({ jsonrpc: "2.0", id: request.id, error: {
        code: -32603,
        message: "failed at https://private.example/path\u0000",
        data: { status: "custom_failure", detail: "safe detail", secretToken: "must-not-leak" }
      } });
    } else if (request.method === "tools/call") {
      const { name, arguments: args } = request.params;
      const operation = toolSequence.length < 2 ? callTool(name, args) : actionTool(name, args);
      operation.then(respond).catch((error) => send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } }));
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
