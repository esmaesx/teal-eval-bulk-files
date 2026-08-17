#!/usr/bin/env node
// Node 24, dependency-free client for the narrow Teal extension bridge.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PersistentBridgeClient } from "./persistent-mcp-client.mjs";
import uploadLifetime from "./upload-lifetime.js";
import {
  createPrivateSnapshotContainer,
  finalizePrivateSnapshot,
  inspectPrivateSnapshot,
  removePrivateSnapshot,
  renewPrivateSnapshot,
  scavengeExpiredPrivateSnapshots
} from "./upload-snapshot-store.mjs";
import { fileURLToPath } from "node:url";

const BRIDGE_GLOBAL = "__TEAL_EVAL_BULK_V09_BRIDGE__";
const ISSUE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const BRIDGE_AUTHORIZATION_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const APPLY_UPLOAD_TIMEOUT_MS = uploadLifetime.cliApplyTimeoutMs;
const APPLY_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000 + 30 * 60 * 1000;
const APPLY_DELETE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CDP_REQUEST_TIMEOUT_MS = 30_000;
const STATE_LOCK_STALE_MS = 15 * 60 * 1000;
const UPLOAD_SNAPSHOT_RETENTION_MS = uploadLifetime.snapshotRetentionMs;
const MAX_UPLOAD_SNAPSHOT_FILES = 500;
const EXIT_USAGE = 2;
const EXIT_CONNECTION = 3;
const EXIT_OPERATION = 4;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXIT_MEANINGS = Object.freeze({
  [0]: "completed",
  [EXIT_USAGE]: "usage error",
  [EXIT_CONNECTION]: "connection error",
  [EXIT_OPERATION]: "operation failed or indeterminate"
});
let activePersistentBridgePath = "";

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, exitCode = EXIT_OPERATION, extra = {}) {
  diagnostic(message);
  printJson({ ok: false, error: message, ...extra, exitCode, exitMeaning: EXIT_MEANINGS[exitCode] || "operation failed" });
  process.exitCode = exitCode;
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cdp" || value === "--browser" || value === "--persistent-bridge" || value === "--user-data-dir" || value === "--issue" || value === "--state" || value === "--ttl-seconds" || value === "--target-id") {
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
  if (!command || !["status", "list", "plan-upload", "apply-upload", "plan-download", "apply-download", "plan-delete", "apply-delete", "verify", "stop"].includes(command)) {
    throw new Error("Use one of: status, list, plan-upload, apply-upload, plan-download, apply-download, plan-delete, apply-delete, verify, stop.");
  }
  if (["status", "list", "stop"].includes(command) && positional.length) throw new Error(`${command} does not accept operands.`);
  if (["plan-upload", "verify", "plan-download", "plan-delete"].includes(command) && positional.length === 0) throw new Error(`${command} requires at least one file ${["plan-upload", "verify"].includes(command) ? "path" : "name"}.`);
  if (["apply-upload", "apply-download", "apply-delete"].includes(command) && positional.length !== 1) throw new Error(`${command} requires exactly one plan token.`);
  if (!options.issue) throw new Error("--issue is required.");
  const connectionCount = [options.cdp, options.browser, options["persistent-bridge"]].filter(Boolean).length;
  if (connectionCount !== 1) throw new Error("Use exactly one connection option: --persistent-bridge, --cdp, or --browser.");
  if (options["persistent-bridge"] && !isAbsolute(options["persistent-bridge"])) throw new Error("--persistent-bridge requires an absolute stdio proxy path.");
  if (options.browser && !["chrome", "edge"].includes(String(options.browser).toLowerCase())) throw new Error("--browser must be chrome or edge.");
  if (options["user-data-dir"] && !options.browser) throw new Error("--user-data-dir can be used only with --browser.");
  const issueIdentifier = String(options.issue).toUpperCase();
  if (!ISSUE_PATTERN.test(issueIdentifier)) throw new Error("The issue identifier is invalid.");
  const targetId = options["target-id"] || "";
  if (targetId && !TARGET_ID_PATTERN.test(targetId)) throw new Error("--target-id must be a safe bounded target identifier.");
  const ttlSeconds = options["ttl-seconds"] === undefined ? 300 : Number(options["ttl-seconds"]);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("--ttl-seconds must be an integer from 1 through 3600.");
  return {
    command,
    operands: positional,
    cdp: options.cdp || "",
    browser: options.browser ? String(options.browser).toLowerCase() : "",
    persistentBridge: options["persistent-bridge"] || "",
    userDataDir: options["user-data-dir"] || "",
    targetId,
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
        if (message.error) {
          const error = new Error(`CDP ${message.error.code}: ${message.error.message}`);
          error.requestDispatched = pending.dispatched === true;
          error.method = pending.method;
          pending.reject(error);
        } else pending.resolve(message.result);
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

function sanitizedTargetDescriptors(matches, idKey) {
  return matches.map((target) => {
    const rawTitle = String(target?.title || "");
    const title = rawTitle
      .replace(/\b(?:https?|chrome|edge|devtools):\/\/\S+/giu, "[url]")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .slice(0, 160) || "(untitled)";
    return { targetId: String(target?.[idKey] || "").slice(0, 128), title };
  });
}

function sanitizeBridgeText(value, fallback = "The persistent bridge failed.") {
  return String(value || fallback)
    .replace(/\b(?:https?|chrome|edge|devtools|ws|wss):\/\/\S+/giu, "[url]")
    .replace(/--?(?:token|secret|cookie|authorization|credential|password)\b(?:=|\s+)\S+/giu, "[redacted]")
    .replace(/\b(?:command(?:[ _-]?line)?|argv|page[ _-]?data)\s*[:=]\s*[^\r\n]*/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000) || fallback;
}

function sanitizeBridgeData(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeBridgeText(value, "").slice(0, 500);
  if (!value || typeof value !== "object" || depth >= 5 || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeBridgeData(item, depth + 1, seen)).filter((item) => item !== undefined);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 25)) {
    if (/token|secret|cookie|authorization|credential|password|websocket|header|command|argv|argument|page|tab|target|snapshot|html|selector/iu.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    const sanitized = sanitizeBridgeData(item, depth + 1, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function authenticatedLeaseOwnerPid(error, status) {
  if (status !== "lease_busy") return null;
  const data = error?.rpcData ?? error?.data;
  const candidates = [data?.owner_pid, data?.ownerPid, data?.owner?.pid, error?.owner_pid, error?.ownerPid];
  const pid = candidates.find((value) => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff);
  return pid ?? null;
}

function noMatchingTabError() {
  const error = new Error("The browser transport responded, but the required allowed issue tab is not open. No mutation started.");
  error.errorKind = "no_matching_tab";
  error.status = "no_matching_tab";
  error.transportResponded = true;
  error.mutationStarted = false;
  error.exitCode = EXIT_CONNECTION;
  return error;
}

function daemonRecoveryError(error, persistentBridgePath) {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!persistentBridgePath && original.errorKind !== "no_matching_tab") return original;
  const text = sanitizeBridgeText(original.message, "The persistent bridge failed.");
  const status = String(original.status || original.data?.status || original.rpcData?.status || "").toLocaleLowerCase("en-US");
  let errorKind = original.errorKind || "";
  if (errorKind === "rpc_error" && status && status !== "rpc_error") errorKind = "";
  if (!errorKind) {
    if (status === "no_matching_tab") errorKind = "no_matching_tab";
    else if (["daemon_absent", "daemon_not_running", "named_pipe_absent", "backend_absent"].includes(status)
      || /named pipe[^\n]*(?:absent|not found|enoent)|enoent[^\n]*named pipe/iu.test(text)) errorKind = "daemon_absent";
    else if (["lease_busy", "held_unknown", "lease_held"].includes(status)
      || /(?:lease|browser transport)[^\n]*(?:busy|in use|held)/iu.test(text)) errorKind = "lease_busy";
    else if (status === "daemon_timeout" || original.timeout === true || /(?:backend|daemon|persistent chrome proxy)[^\n]*(?:timed out|timeout)/iu.test(text)) errorKind = "daemon_timeout";
    else if (status === "proxy_lifecycle" || /persistent chrome (?:stdio )?proxy (?:session )?(?:closed|did not start|was not found|is closed|did not exit)/iu.test(text)) errorKind = "proxy_lifecycle";
    else if (Number.isInteger(original.rpcCode) || original.name === "McpRpcError") errorKind = "rpc_error";
    else errorKind = "generic_bridge_error";
  }
  if (original.indeterminate === true) {
    original.errorKind = errorKind;
    return original;
  }
  const proxyDir = dirname(resolve(persistentBridgePath));
  const runtimeDir = basename(proxyDir).toLocaleLowerCase("en-US") === "runtime" ? proxyDir : join(proxyDir, "runtime");
  const statusCommand = join(runtimeDir, "status.ps1");
  const leaseOwnerPid = authenticatedLeaseOwnerPid(original, status);
  let message = text;
  if (errorKind === "daemon_absent") {
    message = `The persistent Chrome daemon is absent. Run ${statusCommand}. If status confirms that the daemon is absent and you have local authority, run ${join(runtimeDir, "start-daemon.ps1")}. No daemon was started and no request was retried.`;
  } else if (errorKind === "lease_busy") {
    message = leaseOwnerPid
      ? `The browser transport lease is busy. The authenticated lease owner PID is ${leaseOwnerPid}. Run ${statusCommand} and check that exact process state. Do not kill or restart a process by count or age. No request was retried.`
      : `The browser transport lease is busy. The owner is unknown. Run ${statusCommand} and check the exact owner and process state. Do not kill or restart a process by count or age. No request was retried.`;
  } else if (errorKind === "daemon_timeout") {
    message = `The persistent Chrome daemon did not respond before the timeout. Run ${statusCommand}. backend_connected: true does not prove that the lease is free. Do not kill or restart a process automatically. No request was retried.`;
  } else if (errorKind === "proxy_lifecycle") {
    message = `The persistent Chrome stdio proxy did not complete its lifecycle. Run ${statusCommand}. backend_connected: true does not prove that the lease is free. Do not kill or restart a process automatically. No request was retried.`;
  } else if (errorKind === "rpc_error") {
    message = `${text} Run ${statusCommand}. backend_connected: true does not prove that the lease is free. Do not kill or restart a process automatically. No request was retried.`;
  } else if (errorKind === "generic_bridge_error") {
    message = `${text} Run ${statusCommand}. Check the exact owner and process state. Do not kill or restart a process automatically. No request was retried.`;
  }
  const mapped = new Error(message);
  for (const key of ["rpcCode", "rpcMessage", "rpcData", "data", "status", "method", "transportResponded", "mutationStarted"]) {
    if (original[key] !== undefined) mapped[key] = original[key];
  }
  mapped.errorKind = errorKind;
  if (errorKind === "lease_busy") mapped.leaseOwner = leaseOwnerPid ? { owner_pid: leaseOwnerPid } : "unknown";
  const connectionKind = ["daemon_absent", "lease_busy", "daemon_timeout", "proxy_lifecycle", "rpc_error", "no_matching_tab"].includes(errorKind);
  mapped.exitCode = original.exitCode || (connectionKind ? EXIT_CONNECTION : EXIT_OPERATION);
  return mapped;
}

function bridgeErrorOutput(error) {
  const output = {};
  if (typeof error?.errorKind === "string") output.errorKind = error.errorKind;
  if (typeof error?.status === "string") output.bridgeStatus = sanitizeBridgeText(error.status, "");
  if (Number.isInteger(error?.rpcCode)) output.rpcCode = error.rpcCode;
  if (typeof error?.rpcMessage === "string") output.rpcMessage = sanitizeBridgeText(error.rpcMessage);
  let data = sanitizeBridgeData(error?.rpcData ?? error?.data);
  if (error?.leaseOwner === "unknown" && data && typeof data === "object" && !Array.isArray(data)) {
    data = Object.fromEntries(Object.entries(data).filter(([key]) => !/^owner(?:_|$)|^ownerPid$/iu.test(key)));
  }
  if (data !== undefined) output.errorData = data;
  if (error?.leaseOwner === "unknown") output.leaseOwner = "unknown";
  else if (Number.isSafeInteger(error?.leaseOwner?.owner_pid)) output.leaseOwner = { owner_pid: error.leaseOwner.owner_pid };
  if (error?.transportResponded === true) output.transportResponded = true;
  if (error?.mutationStarted === false) output.mutationStarted = false;
  if (error?.indeterminate === true) output.indeterminate = true;
  return output;
}

function selectAllowedTarget(matches, requestedTargetId, idKey) {
  const allowed = matches.filter((target) => TARGET_ID_PATTERN.test(String(target?.[idKey] || "")));
  const selected = requestedTargetId ? allowed.filter((target) => String(target[idKey]) === requestedTargetId) : allowed;
  if (selected.length === 1) return selected[0];
  if (!selected.length) throw noMatchingTabError();
  throw new Error(`More than one matching allowed issue tab is open (${selected.length}). Matching targets: ${JSON.stringify(sanitizedTargetDescriptors(selected, idKey))}`);
}

async function attachToBrowserIssue(browser, userDataDir, issueIdentifier, requestedTargetId = "") {
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
    const target = selectAllowedTarget(matches, requestedTargetId, "targetId");
    const attached = await client.request("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null);
    if (!attached?.sessionId) throw new Error("The browser did not create a target session.");
    client.sessionId = attached.sessionId;
    client.targetId = target.targetId;
    client.targetUrl = target.url;
    client.targetTitle = String(target.title || "");
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function attachToExistingIssue(cdpUrl, issueIdentifier, requestedTargetId = "") {
  const endpoint = validateLoopbackCdp(cdpUrl);
  const targetResponse = await fetch(new URL("/json/list", endpoint));
  if (!targetResponse.ok) throw new Error(`The local CDP endpoint returned ${targetResponse.status}.`);
  const targets = await targetResponse.json();
  if (!Array.isArray(targets)) throw new Error("The local CDP endpoint returned no target list.");
  const matches = targets.filter((target) => target?.type === "page" && issueFromTargetUrl(target.url) === issueIdentifier && typeof target.webSocketDebuggerUrl === "string");
  const target = selectAllowedTarget(matches, requestedTargetId, "id");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  client.targetId = target.id;
  client.targetUrl = target.url;
  client.targetTitle = String(target.title || "");
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
  let result;
  try {
    result = await client.request("Runtime.callFunctionOn", {
      executionContextId: contextId,
      functionDeclaration: `function(command) { const bridge = globalThis.${BRIDGE_GLOBAL}; if (!bridge || typeof bridge.command !== "function") throw new Error("The isolated extension bridge is unavailable."); return bridge.command(command); }`,
      arguments: [{ value: command }],
      awaitPromise: true,
      returnByValue: true,
      silent: true,
      userGesture: false
    }, client.sessionId, timeoutMs);
  } catch (error) {
    if (error?.requestDispatched === true) error.directBridgeDispatched = true;
    throw error;
  }
  if (result.exceptionDetails) {
    const error = new Error(result.exceptionDetails.text || "The isolated extension bridge rejected the command.");
    error.directBridgeDispatched = true;
    throw error;
  }
  if (!Object.prototype.hasOwnProperty.call(result.result || {}, "value")) {
    const error = new Error("The isolated extension bridge returned no JSON value.");
    error.directBridgeDispatched = true;
    throw error;
  }
  return result.result.value;
}

function findCliBridgeUploadInput(node) {
  if (!node || typeof node !== "object") return null;
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  let className = "";
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === "class") className = attributes[index + 1] || "";
  }
  if (node.nodeName === "INPUT" && className.split(/\s+/).includes("cli-bridge-upload") && Number.isInteger(node.nodeId)) return node.nodeId;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findCliBridgeUploadInput(child);
    if (found) return found;
  }
  return null;
}

async function setCliBridgeUploadFiles(client, filePaths, { beforeFileSelection, afterFileSelection } = {}) {
  if (!filePaths.length) throw new Error("apply-upload requires at least one local file path.");
  for (const filePath of filePaths) {
    const document = await client.request("DOM.getDocument", { depth: -1, pierce: true });
    const nodeId = findCliBridgeUploadInput(document.root);
    if (!nodeId) throw new Error("The CLI upload selection input was not found in the allowed tab.");
    if (typeof beforeFileSelection === "function") await beforeFileSelection(filePath);
    await client.request("DOM.setFileInputFiles", { files: [filePath], nodeId });
    if (typeof afterFileSelection === "function") await afterFileSelection(filePath);
    await sleep(50);
  }
  return filePaths.map((filePath) => basename(filePath));
}

function sizeTextForBytes(size) {
  if (!Number.isSafeInteger(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

async function streamFileSha256(absolutePath) {
  const hash = createHash("sha256");
  let byteCount = 0;
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => {
      byteCount += chunk.length;
      hash.update(chunk);
    });
    stream.once("error", rejectStream);
    stream.once("end", resolveStream);
  });
  return { sha256: hash.digest("hex"), byteCount };
}

async function inspectUploadFiles(filePaths) {
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error("plan-upload requires at least one absolute local file path.");
  const files = [];
  const names = new Set();
  for (const filePath of filePaths) {
    if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new Error("Upload paths must be absolute local file paths.");
    const absolutePath = resolve(filePath);
    const before = await lstat(absolutePath).catch(() => null);
    if (!before || !before.isFile() || before.isSymbolicLink()) throw new Error(`The upload path was not a safe regular file: ${absolutePath}`);
    const filename = basename(absolutePath);
    const key = filename.toLocaleLowerCase("en-US");
    const { sha256, byteCount } = await streamFileSha256(absolutePath);
    const after = await lstat(absolutePath).catch(() => null);
    if (!after || !after.isFile() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || after.size !== byteCount
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`The upload file changed while it was read: ${absolutePath}`);
    }
    files.push({ absolutePath, filename, size: after.size, sha256, repeated: names.has(key) });
    names.add(key);
  }
  return files;
}

async function removeUploadSnapshot(snapshot) {
  if (snapshot?.directory) {
    await removePrivateSnapshot(snapshot.directory, {
      rootPath: snapshot.root,
      expectedNonce: snapshot.nonce,
      expectedDeadline: snapshot.retentionDeadline
    });
  }
}

async function createVerifiedUploadSnapshot(actionableFiles, {
  createContainer = createPrivateSnapshotContainer,
  finalizeSnapshot = finalizePrivateSnapshot,
  inspectSnapshot = inspectPrivateSnapshot,
  removeSnapshot = removePrivateSnapshot
} = {}) {
  if (!Array.isArray(actionableFiles) || actionableFiles.length > MAX_UPLOAD_SNAPSHOT_FILES) {
    throw new Error(`An upload apply supports at most ${MAX_UPLOAD_SNAPSHOT_FILES} verified files.`);
  }
  if (!actionableFiles.length) return null;
  let totalBytes = 0;
  const names = new Set();
  for (const file of actionableFiles) {
    if (!file || typeof file.absolutePath !== "string" || !isAbsolute(file.absolutePath)
      || typeof file.filename !== "string" || basename(file.absolutePath) !== file.filename
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256 || "")) {
      throw new Error("The saved upload file evidence was invalid.");
    }
    const key = file.filename.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("The saved upload filenames were not unique.");
    names.add(key);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("The saved upload byte total was too large.");
  }

  const container = await createContainer({ buildTimeoutMs: uploadLifetime.snapshotBuildTimeoutMs });
  let cleanupIdentity = container;
  const directory = container.directory;
  try {
    const snapshotFiles = [];
    for (const expected of actionableFiles) {
      const snapshotPath = join(directory, expected.filename);
      await copyFile(expected.absolutePath, snapshotPath, fsConstants.COPYFILE_EXCL);
      if (process.platform !== "win32") await chmod(snapshotPath, 0o600);
      const [actual] = await inspectUploadFiles([snapshotPath]);
      if (actual.filename !== expected.filename || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
        throw new Error(`The upload file changed after planning: ${expected.absolutePath}`);
      }
      snapshotFiles.push({ ...expected, absolutePath: snapshotPath });
    }
    cleanupIdentity = await finalizeSnapshot(container, snapshotFiles.map((file) => ({
      filename: file.filename,
      size: file.size,
      sha256: file.sha256
    })), { transferLeaseMs: uploadLifetime.snapshotTransferLeaseMs });
    await inspectSnapshot(directory, { rootPath: cleanupIdentity.root });
    return { ...cleanupIdentity, actionableFiles: snapshotFiles, totalBytes };
  } catch (error) {
    try {
      await removeSnapshot(directory, {
        rootPath: cleanupIdentity.root,
        expectedNonce: cleanupIdentity.nonce,
        expectedDeadline: cleanupIdentity.retentionDeadline
      });
    } catch {
      throw new Error("The verified upload snapshot could not be created or safely cleaned.", { cause: error });
    }
    throw error;
  }
}

async function scheduleUploadSnapshotCleanup(snapshot, spawnImpl = spawn) {
  const cleanerPath = fileURLToPath(new URL("./upload-snapshot-cleaner.mjs", import.meta.url));
  const child = spawnImpl(process.execPath, [
    cleanerPath,
    snapshot.directory,
    snapshot.nonce,
    String(snapshot.retentionDeadline)
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("spawn", onSpawn);
      child.removeListener?.("error", onError);
      if (error) rejectSpawn(error);
      else resolveSpawn();
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error("The upload snapshot cleaner did not start in time.")), 2_000);
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  child.unref();
}

async function retainUploadSnapshot(cli, client, snapshot) {
  if (!snapshot) return null;
  const now = cli?.snapshotNowForTest || client?.snapshotNowForTest || (() => Date.now());
  const renewSnapshot = cli?.renewUploadSnapshotForTest || client?.renewUploadSnapshotForTest || renewPrivateSnapshot;
  const retained = await renewSnapshot(snapshot, {
    state: "retained",
    lifetimeMs: UPLOAD_SNAPSHOT_RETENTION_MS,
    now: now()
  });
  Object.assign(snapshot, retained);
  const testRetention = cli?.retainUploadSnapshotForTest || client?.retainUploadSnapshotForTest;
  if (typeof testRetention === "function") {
    return await testRetention(snapshot, {
      contentBatchTimeoutMs: uploadLifetime.contentBatchTimeoutMs,
      cliApplyTimeoutMs: uploadLifetime.cliApplyTimeoutMs,
      retentionMs: UPLOAD_SNAPSHOT_RETENTION_MS,
      safetyMarginMs: uploadLifetime.snapshotSafetyMarginMs
    });
  }
  const scheduler = cli?.scheduleUploadSnapshotCleanupForTest || client?.scheduleUploadSnapshotCleanupForTest || scheduleUploadSnapshotCleanup;
  try {
    await scheduler(snapshot);
    return null;
  } catch {
    return {
      kind: "snapshot_cleanup_not_scheduled",
      message: "The private upload snapshot cleanup process did not start. A later CLI start can remove it only after its safe retention deadline. The apply remains indeterminate and must not be retried."
    };
  }
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
  const absoluteStatePath = resolve(statePath);
  await mkdir(dirname(absoluteStatePath), { recursive: true });
  const temporaryPath = `${absoluteStatePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(state), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, absoluteStatePath);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function withStateLock(statePath, action) {
  const absoluteStatePath = resolve(statePath);
  const lockPath = `${absoluteStatePath}.lock`;
  await mkdir(dirname(absoluteStatePath), { recursive: true });
  const nonce = randomBytes(24).toString("hex");
  const metadata = { version: 1, pid: process.pid, createdAt: Date.now(), nonce };
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let lockIsStrict = false;
    try {
      const lockStat = await lstat(lockPath);
      if (lockStat.isFile() && !lockStat.isSymbolicLink() && lockStat.size > 0 && lockStat.size <= 512) {
        const existing = JSON.parse(await readFile(lockPath, "utf8"));
        const exact = existing && typeof existing === "object" && !Array.isArray(existing)
          && Object.keys(existing).sort().join(",") === "createdAt,nonce,pid,version"
          && existing.version === 1 && Number.isSafeInteger(existing.pid) && existing.pid > 0
          && Number.isSafeInteger(existing.createdAt) && typeof existing.nonce === "string" && /^[a-f0-9]{48}$/u.test(existing.nonce);
        const age = exact ? Date.now() - existing.createdAt : -1;
        let ownerState = "unknown";
        if (exact) {
          try {
            process.kill(existing.pid, 0);
            ownerState = "live";
          } catch (ownerError) {
            ownerState = ownerError?.code === "ESRCH" ? "dead" : "unknown";
          }
        }
        lockIsStrict = exact && age >= 0 && (age < STATE_LOCK_STALE_MS || ownerState !== "dead");
      }
    } catch { }
    const lockError = new Error(lockIsStrict
      ? "The local plan state is locked by another live or unverified process. No mutation started."
      : "The local plan state lock is stale or invalid. It was not removed automatically. No mutation started.");
    lockError.errorKind = "state_lock_busy";
    throw lockError;
  }

  try {
    await handle.writeFile(JSON.stringify(metadata), "utf8");
    await handle.sync();
    return await action();
  } finally {
    await handle.close().catch(() => {});
    let owned = false;
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      owned = current?.nonce === nonce && current?.pid === process.pid;
    } catch { }
    if (owned) await unlink(lockPath).catch(() => {});
  }
}

function createToken(state, record) {
  let token;
  do token = randomBytes(32).toString("base64url"); while (state.tokens[token]);
  state.tokens[token] = record;
  return token;
}

function validatePlanToken(record, { issueIdentifier, operation, targetId, now = Date.now() }) {
  if (!record || typeof record !== "object") throw new Error("The plan token was not found.");
  if (operation === "upload" && record.tokenSchemaVersion !== 2) throw new Error("This upload plan token predates 0.9.6 and cannot be applied safely.");
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
  const names = command === "apply-upload" ? record.actionableNames : record.requestedNames;
  if (!Array.isArray(names) || !names.length || !names.every((name) => typeof name === "string")) throw new Error("The saved actionable file list was invalid.");
  return {
    command,
    names: [...names],
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
  const observedInventory = Array.isArray(result?.inventory) ? result.inventory : record.inventory;
  if (operation === "upload") {
    const actionableFiles = Array.isArray(record.actionableFiles) ? record.actionableFiles : [];
    normalized.uploadedBeforeFailure = actionableFiles
      .filter((file) => observedInventory.some((row) => row?.filename === file.filename && row?.sha256 === file.sha256))
      .map((file) => file.filename);
  } else if ((operation === "download" || operation === "delete") && Array.isArray(record.actionableFiles)) {
    normalized.actionableFiles = record.actionableFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, sizeText: file.sizeText }));
  }
  if (typeof result?.archiveFilename === "string") normalized.archiveFilename = result.archiveFilename;
  if (Number.isInteger(result?.downloadId)) normalized.downloadId = result.downloadId;
  return normalized;
}

function publicActionableFiles(actionableNames, inventory) {
  const remaining = [...actionableNames];
  const files = [];
  for (const name of remaining) {
    const matches = inventory.filter((row) => row.filename === name);
    if (matches.length === 1) files.push({ filename: matches[0].filename, sha256: matches[0].sha256, sizeText: matches[0].sizeText });
  }
  return files;
}

function classifyLocalUploadFiles(files, inventory) {
  const stagedNames = new Set(inventory.map((row) => row.filename.toLocaleLowerCase("en-US")));
  const actionableFiles = [];
  const skipped = [];
  for (const file of files) {
    if (file.repeated) {
      skipped.push({ name: file.filename, reason: "repeated requested filename" });
    } else if (stagedNames.has(file.filename.toLocaleLowerCase("en-US"))) {
      skipped.push({ name: file.filename, reason: "already staged" });
    } else {
      actionableFiles.push({ absolutePath: file.absolutePath, filename: file.filename, size: file.size, sha256: file.sha256 });
    }
  }
  return { actionableFiles, skipped };
}

async function getCurrentInventory(client, contextId) {
  const listed = client.mode === "persistent"
    ? (await client.callBridge({ command: "list" }, { timeoutMs: 30_000 })).result
    : await callBridge(client, contextId, { command: "list" });
  if (!listed?.ok) throw new Error(listed?.error || "The controller did not return the current inventory.");
  return canonicalInventory(listed.inventory);
}

async function createPlan(cli, client, contextId) {
  const operation = cli.command.slice("plan-".length);
  let names = cli.operands;
  let inventory;
  let publicResult;
  let bridgeAuthorizationId = "";
  let actionableFiles = [];
  if (operation === "upload") {
    const localFiles = await inspectUploadFiles(cli.operands);
    inventory = await getCurrentInventory(client, contextId);
    const classified = classifyLocalUploadFiles(localFiles, inventory);
    actionableFiles = classified.actionableFiles;
    names = localFiles.map((file) => file.filename);
    publicResult = {
      ok: true,
      issueIdentifier: cli.issueIdentifier,
      operation,
      requestedNames: names,
      actionableNames: actionableFiles.map((file) => file.filename),
      actionableFiles: actionableFiles.map(({ filename, size, sha256 }) => ({ filename, sha256, sizeText: sizeTextForBytes(size) })),
      skipped: classified.skipped,
      inventory
    };
  } else {
    const result = client.mode === "persistent"
      ? (await client.callBridge({ command: cli.command, names }, { timeoutMs: 30_000 })).result
      : await callBridge(client, contextId, { command: cli.command, names });
    if (!result?.ok) throw new Error(result?.error || "The controller could not create a plan.");
    if (!BRIDGE_AUTHORIZATION_PATTERN.test(result.authorizationId || "")) throw new Error("The controller returned no valid CLI plan authorization.");
    const { authorizationId, ...withoutAuthorization } = result;
    bridgeAuthorizationId = authorizationId;
    inventory = canonicalInventory(result.inventory);
    actionableFiles = publicActionableFiles(Array.isArray(withoutAuthorization.actionableNames) ? withoutAuthorization.actionableNames : [], inventory);
    publicResult = {
      ...withoutAuthorization,
      inventory,
      ...(operation === "download" || operation === "delete" ? { actionableFiles } : {})
    };
  }
  const saved = await withStateLock(cli.statePath, async () => {
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
      ...(operation === "upload" ? { tokenSchemaVersion: 2, actionableFiles } : {}),
      ...(operation === "download" || operation === "delete" ? { actionableFiles } : {}),
      skipped: Array.isArray(publicResult.skipped) ? publicResult.skipped : [],
      ...(bridgeAuthorizationId ? { bridgeAuthorizationId } : {}),
      inventory,
      issuedAt: now,
      expiresAt: now + cli.ttlMs,
      consumed: false
    });
    await saveState(cli.statePath, state);
    return { token, expiresAt: state.tokens[token].expiresAt };
  });
  return { ...publicResult, inventory, token: saved.token, expiresAt: saved.expiresAt };
}

async function observedInventoryAfterUpload(client, contextId, fallback) {
  try { return await getCurrentInventory(client, contextId); } catch { return fallback; }
}

async function transferUploadFiles(client, contextId, actionableFiles, snapshot, now = () => Date.now()) {
  const paths = actionableFiles.map((file) => file.absolutePath);
  const renewTransferLease = async () => {
    const renewed = await renewPrivateSnapshot(snapshot, {
      state: "transferring",
      lifetimeMs: uploadLifetime.snapshotTransferLeaseMs,
      now: now()
    });
    Object.assign(snapshot, renewed);
  };
  const hooks = { beforeFileSelection: renewTransferLease, afterFileSelection: renewTransferLease };
  let selectedNames;
  if (client.mode === "persistent") {
    selectedNames = await client.uploadFiles(paths, hooks);
  } else {
    const prepared = await callBridge(client, contextId, { command: "prepare-upload" });
    if (!prepared?.ok) throw new Error(prepared?.error || "The extension did not prepare the CLI upload selection.");
    selectedNames = await setCliBridgeUploadFiles(client, paths, hooks);
  }
  const active = await renewPrivateSnapshot(snapshot, {
    state: "browser_active",
    lifetimeMs: UPLOAD_SNAPSHOT_RETENTION_MS,
    now: now()
  });
  Object.assign(snapshot, active);
  return selectedNames;
}

function isCompleteUploadResult(result) {
  return result?.operation === "upload"
    && ["succeeded", "skipped", "failed", "remaining"].every((key) => Array.isArray(result[key]));
}

async function applyUploadPlan(cli, client, contextId, token, record, preTransferInventory, uploadSnapshot) {
  if (!record.actionableFiles.length) {
    return {
      ok: true,
      issueIdentifier: cli.issueIdentifier,
      operation: "upload",
      requestedNames: [...record.requestedNames],
      actionableNames: [],
      succeeded: [],
      skipped: Array.isArray(record.skipped) ? record.skipped : [],
      failed: [],
      remaining: [],
      token,
      tokenConsumed: true
    };
  }
  let observed = preTransferInventory;
  let retainSnapshot = false;
  let terminalResult = null;
  const finish = (value) => {
    terminalResult = value;
    return value;
  };
  try {
    try {
      await transferUploadFiles(
        client,
        contextId,
        uploadSnapshot.actionableFiles,
        uploadSnapshot,
        cli?.snapshotNowForTest || client?.snapshotNowForTest || (() => Date.now())
      );
    } catch (error) {
      retainSnapshot = true;
      observed = await observedInventoryAfterUpload(client, contextId, preTransferInventory);
      return finish(normalizeIndeterminateApplyResult(cli, "upload", record, token, {
        error: `The upload transfer may have changed the extension selection. ${error instanceof Error ? error.message : String(error)}`,
        inventory: observed
      }));
    }
    observed = await observedInventoryAfterUpload(client, contextId, preTransferInventory);
    if (JSON.stringify(observed) !== JSON.stringify(preTransferInventory)) {
      retainSnapshot = true;
      return finish(normalizeIndeterminateApplyResult(cli, "upload", record, token, {
        error: "The staged-file inventory changed after transfer and before extension authorization. No retry was attempted.",
        inventory: observed
      }));
    }
    try {
      const planResult = client.mode === "persistent"
        ? (await client.callBridge({ command: "plan-upload", names: record.actionableNames }, { timeoutMs: 30_000, indeterminateOnDispatch: true })).result
        : await callBridge(client, contextId, { command: "plan-upload", names: record.actionableNames });
      if (!planResult?.ok || !BRIDGE_AUTHORIZATION_PATTERN.test(planResult.authorizationId || "")) {
        throw new Error(planResult?.error || "The extension did not create an upload authorization.");
      }
      const applyRecord = { ...record, bridgeAuthorizationId: planResult.authorizationId };
      const result = client.mode === "persistent"
        ? (await client.callBridge(createApplyBridgeCommand("apply-upload", applyRecord), { timeoutMs: APPLY_UPLOAD_TIMEOUT_MS })).result
        : await callBridge(client, contextId, createApplyBridgeCommand("apply-upload", applyRecord), APPLY_UPLOAD_TIMEOUT_MS);
      if (!result || typeof result !== "object") throw new Error("The extension returned no upload apply result.");
      const completeResult = isCompleteUploadResult(result);
      const stoppedCandidate = completeResult && result.indeterminate !== true && result.failed.length === 0 && result.remaining.length > 0;
      const stopped = stoppedCandidate && result.stopped === true && result.uploadSelectionReleased === true;
      if (stopped) return finish({ ...result, ok: false, stopped: true, token, tokenConsumed: true });
      const reportedFailure = !completeResult
        || result.indeterminate === true
        || result.ok === false
        || result.cancelled === true
        || result.failed.length > 0
        || stoppedCandidate;
      if (reportedFailure) {
        retainSnapshot = true;
        observed = await observedInventoryAfterUpload(client, contextId, observed);
        const normalized = normalizeIndeterminateApplyResult(cli, "upload", record, token, {
          ...result,
          error: !completeResult
            ? "The extension returned an incomplete terminal upload result after file transfer. The upload state is uncertain. No retry was attempted."
            : typeof result.error === "string" && result.error
              ? result.error
              : "The upload returned a failed, cancelled, or uncertain result after file transfer. A reported failed file can already be staged. No retry was attempted.",
          inventory: observed
        });
        return finish({
          ...normalized,
          ...(completeResult ? result : {}),
          ok: false,
          indeterminate: true,
          error: normalized.error,
          token,
          tokenConsumed: true,
          uploadedBeforeFailure: normalized.uploadedBeforeFailure
        });
      }
      return finish({ ...result, token, tokenConsumed: true });
    } catch (error) {
      retainSnapshot = true;
      observed = await observedInventoryAfterUpload(client, contextId, observed);
      return finish(normalizeIndeterminateApplyResult(cli, "upload", record, token, {
        error: `The upload authorization or apply result is uncertain after file transfer. ${error instanceof Error ? error.message : String(error)} No retry was attempted.`,
        inventory: observed
      }));
    }
  } finally {
    if (uploadSnapshot) {
      let cleanupWarning = null;
      if (retainSnapshot) {
        cleanupWarning = await retainUploadSnapshot(cli, client, uploadSnapshot).catch(() => ({
          kind: "snapshot_cleanup_not_scheduled",
          message: "The private upload snapshot cleanup process did not start. A later CLI start can remove it only after its safe retention deadline. The apply remains indeterminate and must not be retried."
        }));
      } else {
        try {
          await removeUploadSnapshot(uploadSnapshot);
        } catch {
          cleanupWarning = await retainUploadSnapshot(cli, client, uploadSnapshot).catch(() => ({
            kind: "snapshot_cleanup_not_scheduled",
            message: "The private upload snapshot could not be removed or scheduled for bounded cleanup. A later CLI start will leave it unchanged unless it passes strict expired-snapshot validation."
          }));
          cleanupWarning ||= {
            kind: "snapshot_cleanup_deferred",
            message: "Immediate private upload snapshot removal failed. A bounded cleanup process was scheduled."
          };
        }
      }
      if (cleanupWarning && terminalResult && typeof terminalResult === "object") terminalResult.cleanupWarning = cleanupWarning;
    }
  }
}

async function applyPlan(cli, client, contextId) {
  const operation = cli.command.slice("apply-".length);
  if (cli.operands.length !== 1) throw new Error(`${cli.command} requires exactly one plan token.`);
  const token = cli.operands[0];
  const now = Date.now();
  const preliminaryState = await loadState(cli.statePath);
  const preliminaryRecord = preliminaryState.tokens[token];
  validatePlanToken(preliminaryRecord, { issueIdentifier: cli.issueIdentifier, operation, targetId: client.targetId, now });
  validatePlanConnection(preliminaryRecord, client);
  const inventory = await getCurrentInventory(client, contextId);
  if (JSON.stringify(inventory) !== JSON.stringify(preliminaryRecord.inventory)) throw new Error("The staged-file inventory changed after planning. No mutation was started.");
  let uploadSnapshot = null;
  if (operation === "upload") uploadSnapshot = await createVerifiedUploadSnapshot(preliminaryRecord.actionableFiles);

  let record;
  try {
    record = await withStateLock(cli.statePath, async () => {
      const state = await loadState(cli.statePath);
      const current = state.tokens[token];
      validatePlanToken(current, { issueIdentifier: cli.issueIdentifier, operation, targetId: client.targetId, now: Date.now() });
      validatePlanConnection(current, client);
      if (JSON.stringify(current) !== JSON.stringify(preliminaryRecord)) {
        throw new Error("The local plan token changed before it could be claimed. No mutation started.");
      }
      current.consumed = true;
      current.consumedAt = Date.now();
      await saveState(cli.statePath, state);
      return current;
    });
  } catch (error) {
    await removeUploadSnapshot(uploadSnapshot).catch(() => {});
    throw error;
  }

  if (operation === "upload") return applyUploadPlan(cli, client, contextId, token, record, inventory, uploadSnapshot);
  const applyTimeoutMs = cli.command === "apply-upload"
    ? APPLY_UPLOAD_TIMEOUT_MS
    : cli.command === "apply-download" ? APPLY_DOWNLOAD_TIMEOUT_MS : APPLY_DELETE_TIMEOUT_MS;
  let result;
  try {
    result = client.mode === "persistent"
      ? (await client.callBridge(createApplyBridgeCommand(cli.command, record), { timeoutMs: applyTimeoutMs })).result
      : await callBridge(client, contextId, createApplyBridgeCommand(cli.command, record), applyTimeoutMs);
  } catch (error) {
    if (client.mode !== "persistent" && (error?.directBridgeDispatched === true || error?.requestDispatched === true)) {
      return normalizeIndeterminateApplyResult(cli, operation, record, token, {
        error: `The direct apply dispatch is indeterminate and may still be running. ${error instanceof Error ? error.message : String(error)}`
      });
    }
    throw error;
  }
  const completeResult = result && typeof result === "object"
    && ["succeeded", "skipped", "failed", "remaining"].every((key) => Array.isArray(result[key]));
  if (!completeResult) {
    return normalizeIndeterminateApplyResult(cli, operation, record, token, {
      ...result,
      error: typeof result?.error === "string" && result.error
        ? result.error
        : "The controller returned no proved terminal apply result after dispatch. Run a read-only list. Do not replay this apply."
    });
  }
  if (result.indeterminate === true && operation !== "delete") return normalizeIndeterminateApplyResult(cli, operation, record, token, result);
  return {
    ...result,
    ...((operation === "download" || operation === "delete") && Array.isArray(record.actionableFiles)
      ? { actionableFiles: record.actionableFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, sizeText: file.sizeText })) }
      : {}),
    token,
    tokenConsumed: true
  };
}

function classifyCommandResult(command, issueIdentifier, result) {
  const failed = Array.isArray(result?.failed) && result.failed.length > 0;
  const remaining = Array.isArray(result?.remaining) && result.remaining.length > 0;
  const cancelled = result?.cancelled === true;
  const indeterminate = result?.indeterminate === true;
  const output = {
    command,
    issueIdentifier,
    ...result,
    ok: result?.ok !== false && !failed && !remaining && !cancelled && !indeterminate
  };
  const exitCode = output.ok ? 0 : EXIT_OPERATION;
  output.exitCode = exitCode;
  output.exitMeaning = EXIT_MEANINGS[exitCode];
  return { output, exitCode };
}

async function verifyFiles(cli, client, contextId) {
  const localFiles = await inspectUploadFiles(cli.operands);
  if (localFiles.some((file) => file.repeated)) throw new Error("verify requires unique local basenames for an exact-set comparison.");
  const inventory = await getCurrentInventory(client, contextId);
  const localNames = new Set(localFiles.map((file) => file.filename));
  const matched = [];
  const mismatched = [];
  const missingRemotely = [];
  for (const file of localFiles) {
    const matches = inventory.filter((row) => row.filename === file.filename);
    if (!matches.length) missingRemotely.push({ filename: file.filename, sha256: file.sha256, sizeText: sizeTextForBytes(file.size) });
    else if (matches.length !== 1) mismatched.push({ filename: file.filename, localSha256: file.sha256, stagedSha256: matches.map((row) => row.sha256), reason: "ambiguous staged rows" });
    else if (matches.some((row) => row.sha256 === file.sha256)) matched.push({ filename: file.filename, sha256: file.sha256, sizeText: sizeTextForBytes(file.size) });
    else mismatched.push({ filename: file.filename, localSha256: file.sha256, stagedSha256: matches.map((row) => row.sha256) });
  }
  const missingLocally = inventory
    .filter((row) => !localNames.has(row.filename))
    .map((row) => ({ filename: row.filename, sha256: row.sha256, sizeText: row.sizeText }));
  return {
    ok: mismatched.length === 0 && missingRemotely.length === 0 && missingLocally.length === 0,
    operation: "verify",
    matched,
    mismatched,
    missingRemotely,
    missingLocally
  };
}

async function run() {
  let cli;
  try {
    cli = parseArguments(process.argv.slice(2));
  } catch (error) {
    error.exitCode = EXIT_USAGE;
    throw error;
  }
  const startupCleanup = await scavengeExpiredPrivateSnapshots().catch(() => ({
    removed: 0,
    active: 0,
    warnings: ["The private upload snapshot root could not be checked. No stale snapshot was removed."]
  }));
  let client;
  try {
    try {
      activePersistentBridgePath = cli.persistentBridge;
      if (cli.persistentBridge) client = await new PersistentBridgeClient(cli.persistentBridge, cli.issueIdentifier, { targetId: cli.targetId }).attach();
      else client = cli.browser
        ? await attachToBrowserIssue(cli.browser, cli.userDataDir, cli.issueIdentifier, cli.targetId)
        : await attachToExistingIssue(cli.cdp, cli.issueIdentifier, cli.targetId);
      client.mode ||= "direct";
    } catch (error) {
      error.exitCode = EXIT_CONNECTION;
      throw error;
    }
    const contextId = client.mode === "persistent" ? null : await findBridgeContext(client);
    let result;
    if (["plan-upload", "plan-download", "plan-delete"].includes(cli.command)) result = await createPlan(cli, client, contextId);
    else if (["apply-upload", "apply-download", "apply-delete"].includes(cli.command)) result = await applyPlan(cli, client, contextId);
    else if (cli.command === "verify") result = await verifyFiles(cli, client, contextId);
    else result = client.mode === "persistent"
      ? (await client.callBridge({ command: cli.command }, { timeoutMs: 30_000 })).result
      : await callBridge(client, contextId, { command: cli.command });
    if (startupCleanup.warnings?.length) result = { ...result, snapshotCleanupWarnings: startupCleanup.warnings };
    const outcome = classifyCommandResult(cli.command, cli.issueIdentifier, result);
    printJson(outcome.output);
    if (outcome.exitCode) process.exitCode = outcome.exitCode;
  } finally {
    await client?.close?.();
  }
}

export { CdpClient, CdpTransportError, applyPlan, applyUploadPlan, bridgeErrorOutput, browserSetupUrl, canonicalInventory, classifyCommandResult, createApplyBridgeCommand, createPlan, createToken, createVerifiedUploadSnapshot, daemonRecoveryError, defaultUserDataDir, findCliBridgeUploadInput, inspectUploadFiles, parseArguments, readBrowserWebSocketEndpoint, retainUploadSnapshot, sanitizedTargetDescriptors, scheduleUploadSnapshotCleanup, selectAllowedTarget, sizeTextForBytes, transferUploadFiles, validateLoopbackCdp, validatePlanConnection, validatePlanToken, verifyFiles };

if (import.meta.main) {
  run().catch((error) => {
    const mapped = daemonRecoveryError(error, activePersistentBridgePath);
    fail(
      mapped instanceof Error ? mapped.message : String(mapped),
      mapped?.exitCode || error?.exitCode || EXIT_OPERATION,
      bridgeErrorOutput(mapped)
    );
  });
}
