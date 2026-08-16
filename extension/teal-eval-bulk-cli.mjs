#!/usr/bin/env node
// Node 24, dependency-free client for the narrow Teal extension bridge.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PersistentBridgeClient } from "./persistent-mcp-client.mjs";

const BRIDGE_GLOBAL = "__TEAL_EVAL_BULK_V09_BRIDGE__";
const ISSUE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const BRIDGE_AUTHORIZATION_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const APPLY_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000 + 10 * 60 * 1000;
const APPLY_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000 + 30 * 60 * 1000;
const APPLY_DELETE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CDP_REQUEST_TIMEOUT_MS = 30_000;
const EXIT_USAGE = 2;
const EXIT_CONNECTION = 3;
const EXIT_OPERATION = 4;

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, exitCode = EXIT_OPERATION, extra = {}) {
  diagnostic(message);
  printJson({ ok: false, error: message, ...extra });
  process.exitCode = exitCode;
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cdp" || value === "--browser" || value === "--persistent-bridge" || value === "--user-data-dir" || value === "--issue" || value === "--state" || value === "--ttl-seconds") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}.`);
      options[value.slice(2)] = next;
      index += 1;
    } else if (value.startsWith("--")) {
      throw new Error(`Unsupported option ${value}.`);
    } else {
      positional.push(value);
    }
  }
  const command = positional.shift();
  if (!command || !["status", "list", "plan-upload", "apply-upload", "plan-download", "apply-download", "plan-delete", "apply-delete", "stop"].includes(command)) {
    throw new Error("Use one of: status, list, plan-upload, apply-upload, plan-download, apply-download, plan-delete, apply-delete, stop.");
  }
  if (["status", "list", "stop"].includes(command) && positional.length) throw new Error(`${command} does not accept operands.`);
  if (["plan-upload", "plan-download", "plan-delete"].includes(command) && positional.length === 0) throw new Error(`${command} requires at least one file ${command === "plan-upload" ? "path" : "name"}.`);
  if (["apply-upload", "apply-download", "apply-delete"].includes(command) && positional.length !== 1) throw new Error(`${command} requires exactly one plan token.`);
  if (!options.issue) throw new Error("--issue is required.");
  const connectionCount = [options.cdp, options.browser, options["persistent-bridge"]].filter(Boolean).length;
  if (connectionCount !== 1) throw new Error("Use exactly one connection option: --persistent-bridge, --cdp, or --browser.");
  if (options["persistent-bridge"] && !isAbsolute(options["persistent-bridge"])) throw new Error("--persistent-bridge requires an absolute stdio proxy path.");
  if (options.browser && !["chrome", "edge"].includes(String(options.browser).toLowerCase())) throw new Error("--browser must be chrome or edge.");
  if (options["user-data-dir"] && !options.browser) throw new Error("--user-data-dir can be used only with --browser.");
  const issueIdentifier = String(options.issue).toUpperCase();
  if (!ISSUE_PATTERN.test(issueIdentifier)) throw new Error("The issue identifier is invalid.");
  const ttlSeconds = options["ttl-seconds"] === undefined ? 300 : Number(options["ttl-seconds"]);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("--ttl-seconds must be an integer from 1 through 3600.");
  return {
    command,
    operands: positional,
    cdp: options.cdp || "",
    browser: options.browser ? String(options.browser).toLowerCase() : "",
    persistentBridge: options["persistent-bridge"] || "",
    userDataDir: options["user-data-dir"] || "",
    issueIdentifier,
    ttlMs: ttlSeconds * 1000,
    statePath: options.state || join(tmpdir(), "teal-eval-bulk-cli-v09-tokens.json")
  };
}

function validateLoopbackCdp(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The CDP endpoint URL is invalid.");
  }
  if (!/^https?:$/.test(url.protocol) || !["127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("The CDP endpoint must use an explicit loopback address.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The CDP endpoint must not include credentials, a query, or a fragment.");
  return url;
}

function issueFromTargetUrl(raw) {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/issue\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/);
    if (!match || url.search || url.hash || url.username || url.password) return "";
    const production = url.protocol === "https:" && url.hostname === "platform-teal-alpha.vercel.app";
    const localTest = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "8769" && match[1].toUpperCase() === "TAB-TEST";
    return production || localTest ? match[1].toUpperCase() : "";
  } catch {
    return "";
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpTransportError extends Error {
  constructor(message, { requestDispatched = false, method = "", timeout = false } = {}) {
    super(message);
    this.name = "CdpTransportError";
    this.transport = true;
    this.requestDispatched = requestDispatched === true;
    this.method = method;
    this.timeout = timeout === true;
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.sessionId = null;
    this.closed = false;
    this.handleMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
    this.handleClose = () => this.failPending("The local CDP WebSocket closed.");
    this.handleError = () => this.failPending("The local CDP WebSocket failed after it opened.");
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  static async connect(url, timeoutMs = 5000) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onOpen = () => finish(resolve);
      const onError = () => finish(() => reject(new Error("The local CDP WebSocket failed.")));
      const onClose = () => finish(() => reject(new Error("The local CDP WebSocket closed before it opened.")));
      const timer = setTimeout(() => {
        if (settled) return;
        finish(() => reject(new Error("The local CDP WebSocket did not open.")));
        socket.close();
      }, timeoutMs);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
    return new CdpClient(socket);
  }

  failPending(message) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new CdpTransportError(message, { requestDispatched: pending.dispatched, method: pending.method }));
    }
  }

  request(method, params = {}, sessionId = this.sessionId, timeoutMs = DEFAULT_CDP_REQUEST_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error("The CDP request timeout was invalid."));
    if (this.closed || this.socket.readyState !== 1) {
      return Promise.reject(new CdpTransportError("The local CDP WebSocket is not open.", { requestDispatched: false, method }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, method, dispatched: false, timer: 0 };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(new CdpTransportError(`The CDP request timed out: ${method}.`, { requestDispatched: pending.dispatched, method, timeout: true }));
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        pending.dispatched = true;
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new CdpTransportError(`The CDP request could not be sent: ${error instanceof Error ? error.message : String(error)}`, { requestDispatched: false, method }));
      }
    });
  }

  close() {
    if (!this.closed) this.failPending("The CDP connection closed.");
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.removeEventListener("error", this.handleError);
    if (this.socket.readyState === 0 || this.socket.readyState === 1) this.socket.close();
  }
}

function defaultUserDataDir(browser) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not available, so the browser data directory cannot be located.");
  return join(localAppData, browser === "edge" ? "Microsoft" : "Google", browser === "edge" ? "Edge" : "Chrome", "User Data");
}

function browserSetupUrl(browser) {
  return browser === "edge" ? "edge://inspect/#remote-debugging" : "chrome://inspect/#remote-debugging";
}

async function readBrowserWebSocketEndpoint(browser, selectedUserDataDir = "") {
  const userDataDir = resolve(selectedUserDataDir || defaultUserDataDir(browser));
  const activePortPath = join(userDataDir, "DevToolsActivePort");
  let stat;
  try {
    stat = await lstat(activePortPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Remote debugging is not enabled for this ${browser} session. Open ${browserSetupUrl(browser)}, enable it, and approve the local connection.`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 3 || stat.size > 2048) throw new Error("The DevToolsActivePort record is not a safe regular file.");
  const lines = (await readFile(activePortPath, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const path = lines[1] || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(path)) {
    throw new Error("The DevToolsActivePort record is invalid.");
  }
  return `ws://127.0.0.1:${port}${path}`;
}

async function attachToBrowserIssue(browser, userDataDir, issueIdentifier) {
  const webSocketEndpoint = await readBrowserWebSocketEndpoint(browser, userDataDir);
  let client;
  try {
    client = await CdpClient.connect(webSocketEndpoint, 30000);
  } catch {
    throw new Error(`The ${browser} session did not grant local debugging access. Open ${browserSetupUrl(browser)}, enable remote debugging, approve the connection, and try again.`);
  }
  try {
    const result = await client.request("Target.getTargets", {}, null);
    const matches = (result.targetInfos || []).filter((target) => target?.type === "page" && issueFromTargetUrl(target.url) === issueIdentifier);
    if (matches.length !== 1) throw new Error(matches.length ? "More than one matching allowed issue tab is open." : "No matching allowed issue tab is already open.");
    const attached = await client.request("Target.attachToTarget", { targetId: matches[0].targetId, flatten: true }, null);
    if (!attached?.sessionId) throw new Error("The browser did not create a target session.");
    client.sessionId = attached.sessionId;
    client.targetId = matches[0].targetId;
    client.targetUrl = matches[0].url;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function attachToExistingIssue(cdpUrl, issueIdentifier) {
  const endpoint = validateLoopbackCdp(cdpUrl);
  const targetResponse = await fetch(new URL("/json/list", endpoint));
  if (!targetResponse.ok) throw new Error(`The local CDP endpoint returned ${targetResponse.status}.`);
  const targets = await targetResponse.json();
  if (!Array.isArray(targets)) throw new Error("The local CDP endpoint returned no target list.");
  const matches = targets.filter((target) => target?.type === "page" && issueFromTargetUrl(target.url) === issueIdentifier && typeof target.webSocketDebuggerUrl === "string");
  if (matches.length !== 1) throw new Error(matches.length ? "More than one matching allowed issue tab is open." : "No matching allowed issue tab is already open.");
  const client = await CdpClient.connect(matches[0].webSocketDebuggerUrl);
  client.targetId = matches[0].id;
  client.targetUrl = matches[0].url;
  return client;
}

async function findBridgeContext(client) {
  await client.request("Runtime.enable");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const contexts = client.events
      .filter((event) => event.method === "Runtime.executionContextCreated" && (!client.sessionId || event.sessionId === client.sessionId))
      .map((event) => event.params?.context)
      .filter((context) => Number.isInteger(context?.id));
    for (const context of contexts) {
      try {
        const check = await client.request("Runtime.evaluate", { expression: `typeof globalThis.${BRIDGE_GLOBAL}`, contextId: context.id, returnByValue: true, silent: true });
        if (check.result?.value === "object") return context.id;
      } catch {
        // A context can disappear during a page update. Keep searching.
      }
    }
    await sleep(100);
  }
  throw new Error("The isolated extension bridge was not found. Reload the unpacked extension and refresh the allowed issue tab.");
}

async function callBridge(client, contextId, command, timeoutMs = DEFAULT_CDP_REQUEST_TIMEOUT_MS) {
  const result = await client.request("Runtime.callFunctionOn", {
    executionContextId: contextId,
    functionDeclaration: `function(command) { const bridge = globalThis.${BRIDGE_GLOBAL}; if (!bridge || typeof bridge.command !== "function") throw new Error("The isolated extension bridge is unavailable."); return bridge.command(command); }`,
    arguments: [{ value: command }],
    awaitPromise: true,
    returnByValue: true,
    silent: true,
    userGesture: false
  }, client.sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "The isolated extension bridge rejected the command.");
  if (!Object.prototype.hasOwnProperty.call(result.result || {}, "value")) throw new Error("The isolated extension bridge returned no JSON value.");
  return result.result.value;
}

function findBulkInput(node) {
  if (!node || typeof node !== "object") return null;
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  let className = "";
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === "class") className = attributes[index + 1] || "";
  }
  if (node.nodeName === "INPUT" && className.split(/\s+/).includes("bulk-input") && Number.isInteger(node.nodeId)) return node.nodeId;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findBulkInput(child);
    if (found) return found;
  }
  return null;
}

async function setUploadFiles(client, filePaths) {
  if (!filePaths.length) throw new Error("plan-upload requires at least one local file path.");
  const document = await client.request("DOM.getDocument", { depth: -1, pierce: true });
  const nodeId = findBulkInput(document.root);
  if (!nodeId) throw new Error("The extension bulk file input was not found in the allowed tab.");
  await client.request("DOM.setFileInputFiles", { files: filePaths, nodeId });
  await sleep(50);
  return filePaths.map((filePath) => basename(filePath));
}

function canonicalInventory(value) {
  if (!Array.isArray(value)) throw new Error("The controller returned an invalid inventory.");
  return value.map((row) => {
    if (!row || typeof row.filename !== "string" || typeof row.sha256 !== "string" || typeof row.sizeText !== "string") throw new Error("The controller returned an invalid inventory row.");
    return { filename: row.filename, sha256: row.sha256, sizeText: row.sizeText };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
}

async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (parsed?.version === 1 && parsed.tokens && typeof parsed.tokens === "object") return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("The token state file was invalid.");
  }
  return { version: 1, tokens: {} };
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), "utf8");
}

function createToken(state, record) {
  let token;
  do token = randomBytes(32).toString("base64url"); while (state.tokens[token]);
  state.tokens[token] = record;
  return token;
}

function validatePlanToken(record, { issueIdentifier, operation, targetId, now = Date.now() }) {
  if (!record || typeof record !== "object") throw new Error("The plan token was not found.");
  if (record.consumed) throw new Error("The plan token was already used.");
  if (record.expiresAt <= now) throw new Error("The plan token expired.");
  if (record.issueIdentifier !== issueIdentifier || record.operation !== operation) throw new Error("The plan token is bound to a different issue or operation.");
  if (String(record.targetId) !== String(targetId)) throw new Error("The plan token is bound to a different target tab.");
}

function validatePlanConnection(record, client) {
  if (record.targetUrl !== client.targetUrl) throw new Error("The plan token is bound to a different issue page URL.");
  if ((record.connectionMode || "direct") !== (client.mode || "direct")) throw new Error("The plan token is bound to a different browser connection mode.");
  if ((record.bridgeDocumentId || "") !== (client.documentId || "")) throw new Error("The issue page was refreshed after the plan token was created.");
  if ((record.targetTitle || "") !== (client.targetTitle || "")) throw new Error("The issue page title changed after the plan token was created.");
}

function createApplyBridgeCommand(command, record) {
  if (!["apply-upload", "apply-download", "apply-delete"].includes(command)) throw new Error("The apply command was invalid.");
  if (!record || !Array.isArray(record.requestedNames) || !record.requestedNames.length) throw new Error("The saved plan file list was invalid.");
  if (!BRIDGE_AUTHORIZATION_PATTERN.test(record.bridgeAuthorizationId || "")) throw new Error("The saved CLI plan authorization was invalid.");
  return {
    command,
    names: [...record.requestedNames],
    authorizationId: record.bridgeAuthorizationId
  };
}

function normalizeIndeterminateApplyResult(cli, operation, record, token, result) {
  const actionableNames = Array.isArray(record.actionableNames) && record.actionableNames.every((name) => typeof name === "string")
    ? [...record.actionableNames]
    : [...record.requestedNames];
  const normalized = {
    ok: false,
    issueIdentifier: cli.issueIdentifier,
    operation,
    requestedNames: [...record.requestedNames],
    actionableNames,
    succeeded: [],
    skipped: Array.isArray(record.skipped) ? record.skipped : [],
    failed: [],
    remaining: actionableNames,
    indeterminate: true,
    error: typeof result?.error === "string" && result.error
      ? result.error
      : "The apply dispatch is indeterminate and may still be running.",
    token,
    tokenConsumed: true
  };
  if (typeof result?.archiveFilename === "string") normalized.archiveFilename = result.archiveFilename;
  if (Number.isInteger(result?.downloadId)) normalized.downloadId = result.downloadId;
  return normalized;
}

async function createPlan(cli, client, contextId) {
  const operation = cli.command.slice("plan-".length);
  const names = operation === "upload"
    ? (client.mode === "persistent" ? await client.uploadFiles(cli.operands) : await setUploadFiles(client, cli.operands))
    : cli.operands;
  if (!names.length) throw new Error(`${cli.command} requires at least one ${operation === "upload" ? "file path" : "filename"}.`);
  const result = client.mode === "persistent"
    ? (await client.callBridge({ command: cli.command, names }, { timeoutMs: 30_000 })).result
    : await callBridge(client, contextId, { command: cli.command, names });
  if (!result?.ok) throw new Error(result?.error || "The controller could not create a plan.");
  if (!BRIDGE_AUTHORIZATION_PATTERN.test(result.authorizationId || "")) throw new Error("The controller returned no valid CLI plan authorization.");
  const { authorizationId, ...publicResult } = result;
  const inventory = canonicalInventory(result.inventory);
  const state = await loadState(cli.statePath);
  const now = Date.now();
  for (const [token, record] of Object.entries(state.tokens)) if (!record || record.expiresAt <= now) delete state.tokens[token];
  const token = createToken(state, {
    issueIdentifier: cli.issueIdentifier,
    operation,
    targetId: client.targetId,
    targetUrl: client.targetUrl,
    targetTitle: client.targetTitle || "",
    connectionMode: client.mode || "direct",
    bridgeDocumentId: client.documentId || "",
    requestedNames: [...names],
    actionableNames: Array.isArray(publicResult.actionableNames) ? [...publicResult.actionableNames] : [],
    skipped: Array.isArray(publicResult.skipped) ? publicResult.skipped : [],
    bridgeAuthorizationId: authorizationId,
    inventory,
    issuedAt: now,
    expiresAt: now + cli.ttlMs,
    consumed: false
  });
  await saveState(cli.statePath, state);
  return { ...publicResult, inventory, token, expiresAt: state.tokens[token].expiresAt };
}

async function applyPlan(cli, client, contextId) {
  const operation = cli.command.slice("apply-".length);
  if (cli.operands.length !== 1) throw new Error(`${cli.command} requires exactly one plan token.`);
  const state = await loadState(cli.statePath);
  const token = cli.operands[0];
  const record = state.tokens[token];
  const now = Date.now();
  validatePlanToken(record, { issueIdentifier: cli.issueIdentifier, operation, targetId: client.targetId, now });
  validatePlanConnection(record, client);
  const listed = client.mode === "persistent"
    ? (await client.callBridge({ command: "list" }, { timeoutMs: 30_000 })).result
    : await callBridge(client, contextId, { command: "list" });
  if (!listed?.ok) throw new Error(listed?.error || "The controller did not return the current inventory.");
  if (JSON.stringify(canonicalInventory(listed.inventory)) !== JSON.stringify(record.inventory)) throw new Error("The staged-file inventory changed after planning. No mutation was started.");
  record.consumed = true;
  record.consumedAt = now;
  await saveState(cli.statePath, state);
  const applyTimeoutMs = cli.command === "apply-upload"
    ? APPLY_UPLOAD_TIMEOUT_MS
    : cli.command === "apply-download" ? APPLY_DOWNLOAD_TIMEOUT_MS : APPLY_DELETE_TIMEOUT_MS;
  let result;
  try {
    result = client.mode === "persistent"
      ? (await client.callBridge(createApplyBridgeCommand(cli.command, record), { timeoutMs: applyTimeoutMs })).result
      : await callBridge(client, contextId, createApplyBridgeCommand(cli.command, record), applyTimeoutMs);
  } catch (error) {
    if (client.mode !== "persistent" && error?.transport === true && error?.requestDispatched === true) {
      return normalizeIndeterminateApplyResult(cli, operation, record, token, {
        error: `The direct apply dispatch is indeterminate and may still be running. ${error instanceof Error ? error.message : String(error)}`
      });
    }
    throw error;
  }
  if (result?.indeterminate === true) return normalizeIndeterminateApplyResult(cli, operation, record, token, result);
  if (!result?.ok && result?.indeterminate !== true) throw new Error(result?.error || "The controller rejected the apply command.");
  return { ...result, token, tokenConsumed: true };
}

function classifyCommandResult(command, issueIdentifier, result) {
  const failed = Array.isArray(result?.failed) && result.failed.length > 0;
  const cancelled = result?.cancelled === true;
  const indeterminate = result?.indeterminate === true;
  const output = {
    command,
    issueIdentifier,
    ...result,
    ok: result?.ok !== false && !failed && !cancelled && !indeterminate
  };
  return { output, exitCode: output.ok ? 0 : EXIT_OPERATION };
}

async function run() {
  let cli;
  try {
    cli = parseArguments(process.argv.slice(2));
  } catch (error) {
    error.exitCode = EXIT_USAGE;
    throw error;
  }
  let client;
  try {
    try {
      if (cli.persistentBridge) client = await new PersistentBridgeClient(cli.persistentBridge, cli.issueIdentifier).attach();
      else client = cli.browser
        ? await attachToBrowserIssue(cli.browser, cli.userDataDir, cli.issueIdentifier)
        : await attachToExistingIssue(cli.cdp, cli.issueIdentifier);
      client.mode ||= "direct";
    } catch (error) {
      error.exitCode = EXIT_CONNECTION;
      throw error;
    }
    const contextId = client.mode === "persistent" ? null : await findBridgeContext(client);
    let result;
    if (["plan-upload", "plan-download", "plan-delete"].includes(cli.command)) result = await createPlan(cli, client, contextId);
    else if (["apply-upload", "apply-download", "apply-delete"].includes(cli.command)) result = await applyPlan(cli, client, contextId);
    else result = client.mode === "persistent"
      ? (await client.callBridge({ command: cli.command }, { timeoutMs: 30_000 })).result
      : await callBridge(client, contextId, { command: cli.command });
    const outcome = classifyCommandResult(cli.command, cli.issueIdentifier, result);
    printJson(outcome.output);
    if (outcome.exitCode) process.exitCode = outcome.exitCode;
  } finally {
    await client?.close?.();
  }
}

export { CdpClient, CdpTransportError, applyPlan, browserSetupUrl, canonicalInventory, classifyCommandResult, createApplyBridgeCommand, createToken, defaultUserDataDir, parseArguments, readBrowserWebSocketEndpoint, validateLoopbackCdp, validatePlanConnection, validatePlanToken };

if (import.meta.main) {
  run().catch((error) => fail(
    error instanceof Error ? error.message : String(error),
    error?.exitCode || EXIT_OPERATION,
    error?.indeterminate === true ? { indeterminate: true } : {}
  ));
}
