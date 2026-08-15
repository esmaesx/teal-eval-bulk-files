#!/usr/bin/env node
// Node 24, dependency-free, local CDP client for the narrow isolated bridge.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BRIDGE_GLOBAL = "__TEAL_EVAL_BULK_V09_BRIDGE__";
const ISSUE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
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
    if (value === "--cdp" || value === "--browser" || value === "--user-data-dir" || value === "--issue" || value === "--state" || value === "--ttl-seconds") {
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
  if (!command || !["status", "list", "plan-upload", "apply-upload", "plan-delete", "apply-delete", "stop"].includes(command)) {
    throw new Error("Use one of: status, list, plan-upload, apply-upload, plan-delete, apply-delete, stop.");
  }
  if (!options.issue) throw new Error("--issue is required.");
  if (Boolean(options.cdp) === Boolean(options.browser)) throw new Error("Use exactly one connection option: --cdp or --browser.");
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

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.sessionId = null;
    socket.addEventListener("message", (event) => {
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
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  static async connect(url, timeoutMs = 5000) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("The local CDP WebSocket did not open."));
      }, timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("The local CDP WebSocket failed.")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  request(method, params = {}, sessionId = this.sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error("The CDP connection closed."));
    this.pending.clear();
    this.socket.close();
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

async function callBridge(client, contextId, command) {
  const result = await client.request("Runtime.callFunctionOn", {
    executionContextId: contextId,
    functionDeclaration: `function(command) { const bridge = globalThis.${BRIDGE_GLOBAL}; if (!bridge || typeof bridge.command !== "function") throw new Error("The isolated extension bridge is unavailable."); return bridge.command(command); }`,
    arguments: [{ value: command }],
    awaitPromise: true,
    returnByValue: true,
    silent: true,
    userGesture: false
  });
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
  if (record.targetId !== targetId) throw new Error("The plan token is bound to a different target tab.");
}

async function createPlan(cli, client, contextId) {
  const operation = cli.command === "plan-upload" ? "upload" : "delete";
  const names = operation === "upload" ? await setUploadFiles(client, cli.operands) : cli.operands;
  if (!names.length) throw new Error(`${cli.command} requires at least one ${operation === "upload" ? "file path" : "filename"}.`);
  const result = await callBridge(client, contextId, { command: cli.command, names });
  if (!result?.ok) throw new Error(result?.error || "The controller could not create a plan.");
  const inventory = canonicalInventory(result.inventory);
  const state = await loadState(cli.statePath);
  const now = Date.now();
  for (const [token, record] of Object.entries(state.tokens)) if (!record || record.expiresAt <= now) delete state.tokens[token];
  const token = createToken(state, {
    issueIdentifier: cli.issueIdentifier,
    operation,
    targetId: client.targetId,
    targetUrl: client.targetUrl,
    requestedNames: [...names],
    inventory,
    issuedAt: now,
    expiresAt: now + cli.ttlMs,
    consumed: false
  });
  await saveState(cli.statePath, state);
  return { ...result, inventory, token, expiresAt: state.tokens[token].expiresAt };
}

async function applyPlan(cli, client, contextId) {
  const operation = cli.command === "apply-upload" ? "upload" : "delete";
  if (cli.operands.length !== 1) throw new Error(`${cli.command} requires exactly one plan token.`);
  const state = await loadState(cli.statePath);
  const token = cli.operands[0];
  const record = state.tokens[token];
  const now = Date.now();
  validatePlanToken(record, { issueIdentifier: cli.issueIdentifier, operation, targetId: client.targetId, now });
  const listed = await callBridge(client, contextId, { command: "list" });
  if (!listed?.ok) throw new Error(listed?.error || "The controller did not return the current inventory.");
  if (JSON.stringify(canonicalInventory(listed.inventory)) !== JSON.stringify(record.inventory)) throw new Error("The staged-file inventory changed after planning. No mutation was started.");
  record.consumed = true;
  record.consumedAt = now;
  await saveState(cli.statePath, state);
  const result = await callBridge(client, contextId, { command: cli.command, names: record.requestedNames });
  if (!result?.ok) throw new Error(result?.error || "The controller rejected the apply command.");
  return { ...result, token, tokenConsumed: true };
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
      client = cli.browser
        ? await attachToBrowserIssue(cli.browser, cli.userDataDir, cli.issueIdentifier)
        : await attachToExistingIssue(cli.cdp, cli.issueIdentifier);
    } catch (error) {
      error.exitCode = EXIT_CONNECTION;
      throw error;
    }
    const contextId = await findBridgeContext(client);
    let result;
    if (cli.command === "plan-upload" || cli.command === "plan-delete") result = await createPlan(cli, client, contextId);
    else if (cli.command === "apply-upload" || cli.command === "apply-delete") result = await applyPlan(cli, client, contextId);
    else result = await callBridge(client, contextId, { command: cli.command });
    const failed = Array.isArray(result?.failed) && result.failed.length > 0;
    const cancelled = result?.cancelled === true;
    printJson({ ok: result?.ok !== false && !failed && !cancelled, command: cli.command, issueIdentifier: cli.issueIdentifier, ...result });
    if (failed || cancelled || result?.ok === false) process.exitCode = EXIT_OPERATION;
  } finally {
    client?.close();
  }
}

export { browserSetupUrl, canonicalInventory, createToken, defaultUserDataDir, parseArguments, readBrowserWebSocketEndpoint, validateLoopbackCdp, validatePlanToken };

if (import.meta.main) {
  run().catch((error) => fail(error instanceof Error ? error.message : String(error), error?.exitCode || EXIT_OPERATION));
}
