import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PERSISTENT_BRIDGE_PROTOCOL_VERSION = 1;
const PERSISTENT_BRIDGE_EXTENSION_VERSION = "0.9.6";
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const DOCUMENT_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const RESULT_PREFIX = "TEAL_CLI_RESULT_";
const ACK_PREFIX = "TEAL_CLI_ACK_";
const COMMAND_CONTROL_NAME = "Teal CLI persistent command";
const UPLOAD_CONTROL_NAME = "Teal CLI persistent upload";
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024;
const MAX_STDERR_BUFFER = 16 * 1024;
const MAX_MARKER_LENGTH = 1024 * 1024;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const EXPECTED_GATEWAY_TOOLS = new Set([
  "allow_remote_debugging", "click", "close_page", "drag", "emulate", "evaluate_script", "fill", "fill_form",
  "get_console_message", "get_network_request", "handle_dialog", "hover", "lighthouse_audit", "list_console_messages",
  "list_network_requests", "list_pages", "navigate_page", "new_page", "performance_analyze_insight",
  "performance_start_trace", "performance_stop_trace", "press_key", "resize_page", "select_page", "take_heapsnapshot",
  "take_screenshot", "take_snapshot", "type_text", "upload_file", "wait_for"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sanitizeDiagnosticText(value, fallback = "The persistent Chrome tool failed.") {
  return String(value || fallback)
    .replace(/\b(?:https?|chrome|edge|devtools|ws|wss):\/\/\S+/giu, "[url]")
    .replace(/--?(?:token|secret|cookie|authorization|credential|password)\b(?:=|\s+)\S+/giu, "[redacted]")
    .replace(/\b(?:command(?:[ _-]?line)?|argv|page[ _-]?data)\s*[:=]\s*[^\r\n]*/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000) || fallback;
}

function sanitizeStructuredData(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeDiagnosticText(value, "").slice(0, 500);
  if (!value || typeof value !== "object" || depth >= 5 || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeStructuredData(item, depth + 1, seen)).filter((item) => item !== undefined);
  }
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 25)) {
    if (/token|secret|cookie|authorization|credential|password|websocket|header|command|argv|argument|page|tab|target|snapshot|html|selector/iu.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    const sanitized = sanitizeStructuredData(item, depth + 1, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function errorText(result) {
  const structured = result?.structuredContent;
  if (typeof structured?.detail === "string") return sanitizeDiagnosticText(structured.detail);
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
    : "";
  return sanitizeDiagnosticText(text);
}

class McpToolError extends Error {
  constructor(message, options = {}) {
    super(sanitizeDiagnosticText(message));
    this.name = "McpToolError";
    this.status = options.status || "tool_failed";
    this.data = sanitizeStructuredData(options.data);
    this.indeterminate = options.indeterminate === true;
  }
}

class McpRpcError extends Error {
  constructor(rpcError, method = "") {
    const code = Number.isInteger(rpcError?.code) ? rpcError.code : null;
    const rpcMessage = sanitizeDiagnosticText(rpcError?.message, "The JSON-RPC request failed.");
    super(`The persistent Chrome proxy rejected the request (${code ?? "error"}): ${rpcMessage}`);
    this.name = "McpRpcError";
    this.rpcCode = code;
    this.rpcMessage = rpcMessage;
    this.rpcData = sanitizeStructuredData(rpcError?.data);
    this.data = this.rpcData;
    this.status = typeof this.rpcData?.status === "string" ? this.rpcData.status : "rpc_error";
    this.method = method;
    this.errorKind = "rpc_error";
  }
}

function proxyLifecycleError(message) {
  const error = new Error(sanitizeDiagnosticText(message));
  error.errorKind = "proxy_lifecycle";
  error.status = "proxy_lifecycle";
  return error;
}

function proxyCloseError(stderr, code, signal, startup) {
  const evidence = String(stderr || "").slice(-MAX_STDERR_BUFFER);
  let startupMarker = null;
  if (startup) {
    const lines = evidence.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const lastLine = lines.at(-1) || "";
    try {
      const parsed = JSON.parse(lastLine);
      const keys = isPlainObject(parsed) ? Object.keys(parsed).sort().join(",") : "";
      if (keys === "cause,component,retryable,schema_version,status"
        && parsed.schema_version === 1
        && parsed.component === "chrome-devtools-persistent-gateway"
        && parsed.status === "startup_failed"
        && parsed.retryable === true
        && typeof parsed.cause === "string") startupMarker = parsed;
    } catch { }
  }
  const daemonAbsent = startupMarker?.cause === "daemon_absent";
  if (daemonAbsent) {
    const error = new Error("The persistent Chrome daemon is absent.");
    error.errorKind = "daemon_absent";
    error.status = "daemon_absent";
    error.data = { status: "daemon_absent", startupExit: Number.isInteger(code) ? code : (signal ? "signal" : "unknown") };
    return error;
  }
  const exit = Number.isInteger(code) ? String(code) : (signal ? "signal" : "unknown");
  return proxyLifecycleError(`The persistent Chrome proxy closed before the request finished (${exit}).`);
}

function daemonTimeoutError(message, method = "") {
  const error = new Error(sanitizeDiagnosticText(message));
  error.errorKind = "daemon_timeout";
  error.status = "daemon_timeout";
  error.method = method;
  return error;
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}

class McpStdioSession {
  constructor(proxyPath, options = {}) {
    this.proxyPath = proxyPath;
    this.spawnProcess = options.spawnProcess || spawn;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.closed = false;
    this.starting = true;
    this.shutdownGraceMs = Number.isInteger(options.shutdownGraceMs) && options.shutdownGraceMs >= 1 ? options.shutdownGraceMs : 2_000;
    this.shutdownTermMs = Number.isInteger(options.shutdownTermMs) && options.shutdownTermMs >= 1 ? options.shutdownTermMs : 2_000;
    this.shutdownResult = null;
  }

  static async open(proxyPath, options = {}) {
    const session = new McpStdioSession(proxyPath, options);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async start() {
    let stat;
    try {
      stat = await lstat(this.proxyPath);
    } catch {
      throw proxyLifecycleError("The persistent Chrome stdio proxy was not found.");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw proxyLifecycleError("The persistent Chrome stdio proxy was not a safe regular file.");
    this.child = this.spawnProcess(process.execPath, [this.proxyPath, "chrome-devtools"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_BUFFER);
    });
    this.child.once("error", () => this.failPending(proxyLifecycleError("The persistent Chrome proxy process did not start.")));
    this.child.once("close", (code, signal) => {
      if (!this.closed) this.failPending(proxyCloseError(this.stderrBuffer, code, signal, this.starting));
    });
    const initialized = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "teal-eval-bulk-cli", version: PERSISTENT_BRIDGE_EXTENSION_VERSION }
    }, 20_000);
    if (!isPlainObject(initialized) || typeof initialized.protocolVersion !== "string") throw new Error("The persistent Chrome proxy returned an invalid initialize result.");
    this.notify("notifications/initialized", {});
    const manifest = await this.request("tools/list", {}, 20_000);
    this.validateToolManifest(manifest?.tools);
    this.starting = false;
  }

  validateToolManifest(tools) {
    if (!Array.isArray(tools)) throw new Error("The persistent Chrome proxy returned no tool manifest.");
    const names = tools.map((tool) => tool?.name);
    if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) throw new Error("The persistent Chrome proxy tool manifest was invalid.");
    const actual = new Set(names);
    const missing = [...EXPECTED_GATEWAY_TOOLS].filter((name) => !actual.has(name));
    const unexpected = [...actual].filter((name) => !EXPECTED_GATEWAY_TOOLS.has(name));
    if (missing.length || unexpected.length || actual.size !== EXPECTED_GATEWAY_TOOLS.size) {
      throw new Error(`The persistent Chrome proxy tool manifest changed. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const schemaAllowsType = (definition, allowedTypes) => {
      if (!isPlainObject(definition)) return false;
      if (allowedTypes.includes(definition.type)) return true;
      for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        if (Array.isArray(definition[keyword]) && definition[keyword].some((entry) => schemaAllowsType(entry, allowedTypes))) return true;
      }
      return false;
    };
    const requireObjectSchema = (name, required, properties) => {
      const schema = byName.get(name)?.inputSchema;
      if (!isPlainObject(schema) || schema.type !== "object" || !isPlainObject(schema.properties)) throw new Error(`The persistent Chrome proxy ${name} schema was invalid.`);
      const actualRequired = Array.isArray(schema.required) ? [...schema.required].sort() : [];
      const expectedRequired = [...required].sort();
      if (JSON.stringify(actualRequired) !== JSON.stringify(expectedRequired)) throw new Error(`The persistent Chrome proxy ${name} required fields changed.`);
      for (const [property, type] of Object.entries(properties)) {
        const definition = schema.properties[property];
        const allowedTypes = Array.isArray(type) ? type : [type];
        if (!schemaAllowsType(definition, allowedTypes)) throw new Error(`The persistent Chrome proxy ${name}.${property} schema changed.`);
      }
    };
    requireObjectSchema("list_pages", [], {});
    requireObjectSchema("select_page", ["pageId"], { pageId: "number", bringToFront: "boolean" });
    requireObjectSchema("take_snapshot", [], { verbose: "boolean" });
    requireObjectSchema("fill", ["uid", "value"], { uid: "string", value: "string", includeSnapshot: "boolean" });
    requireObjectSchema("upload_file", ["uid", "filePath"], { uid: "string", filePath: "string", includeSnapshot: "boolean" });
    requireObjectSchema("wait_for", ["text"], { text: "array", timeout: ["number", "integer"] });
    const waitTextItems = byName.get("wait_for")?.inputSchema?.properties?.text?.items;
    if (!isPlainObject(waitTextItems) || waitTextItems.type !== "string") throw new Error("The persistent Chrome proxy wait_for text schema changed.");
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.failPending(new Error("The persistent Chrome proxy response was too large."));
      void this.close();
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failPending(new Error("The persistent Chrome proxy returned malformed JSON-RPC."));
        void this.close();
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new McpRpcError(message.error, pending.method));
      else pending.resolve(message.result);
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw proxyLifecycleError("The persistent Chrome proxy session is closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(daemonTimeoutError(`The persistent Chrome proxy timed out during ${method}.`, method));
      }, timeoutMs);
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest, timer, method });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        rejectRequest(error);
      }
    });
  }

  async callTool(name, args, timeoutMs = 70_000) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    if (result?.isError === true) {
      const status = typeof result?.structuredContent?.status === "string" ? result.structuredContent.status : "tool_failed";
      throw new McpToolError(errorText(result), {
        status,
        data: result.structuredContent?.data ?? result.structuredContent,
        indeterminate: status === "indeterminate_mutating_call"
      });
    }
    if (!isPlainObject(result)) throw new Error(`The persistent Chrome proxy returned an invalid ${name} result.`);
    return result;
  }

  async close() {
    if (this.closed) return this.shutdownResult;
    this.closed = true;
    this.failPending(proxyLifecycleError("The persistent Chrome proxy session closed."));
    const child = this.child;
    if (!child) {
      this.shutdownResult = { exited: true, signalSent: false };
      return this.shutdownResult;
    }
    try { child.stdin.end(); } catch { }
    if (childExited(child) || await waitForChildExit(child, this.shutdownGraceMs)) {
      this.shutdownResult = { exited: true, signalSent: false };
      return this.shutdownResult;
    }
    let signalSent = false;
    try { signalSent = child.kill("SIGTERM") !== false; } catch { }
    if (childExited(child) || await waitForChildExit(child, this.shutdownTermMs)) {
      this.shutdownResult = { exited: true, signalSent };
      return this.shutdownResult;
    }
    const error = proxyLifecycleError("The persistent Chrome proxy did not exit after SIGTERM.");
    try { child.stdin.destroy?.(); } catch { }
    try { child.stdout?.destroy?.(); } catch { }
    try { child.stderr?.destroy?.(); } catch { }
    try { child.unref?.(); } catch { }
    this.shutdownResult = { exited: false, signalSent, error };
    return this.shutdownResult;
  }
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

function sanitizedPageDescriptors(pages) {
  return pages.map((page) => ({
    targetId: String(page?.id ?? "").slice(0, 128),
    title: (String(page?.title || "")
      .replace(/\b(?:https?|chrome|edge|devtools):\/\/\S+/giu, "[url]")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .slice(0, 160) || "(untitled)")
  }));
}

function selectAllowedPage(pages, issueIdentifier, requestedTargetId = "") {
  const allowed = pages.filter((page) => issueFromTargetUrl(page?.url) === issueIdentifier && TARGET_ID_PATTERN.test(String(page?.id ?? "")));
  const selected = requestedTargetId ? allowed.filter((page) => String(page.id) === requestedTargetId) : allowed;
  if (selected.length === 1) return selected[0];
  if (!selected.length) {
    const error = new Error("The browser transport responded, but the required allowed issue tab is not open. No mutation started.");
    error.errorKind = "no_matching_tab";
    error.status = "no_matching_tab";
    error.transportResponded = true;
    error.mutationStarted = false;
    throw error;
  }
  throw new Error(`More than one matching allowed issue tab is open (${selected.length}). Matching targets: ${JSON.stringify(sanitizedPageDescriptors(selected))}`);
}

function parsePageListResult(result) {
  const structured = result?.structuredContent?.pages;
  if (Array.isArray(structured)) return structured;
  const blocks = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text)
    : [];
  if (blocks.length !== 1 || blocks[0].length > 2 * 1024 * 1024) throw new Error("The persistent Chrome bridge returned no valid page list.");
  const lines = blocks[0].split(/\r?\n/u);
  if (lines.shift()?.trim() !== "## Pages") throw new Error("The persistent Chrome bridge page-list format changed.");
  const pages = [];
  const ids = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+): (.*?) \((\S+)\)(?: \[selected\])?$/u);
    const direct = match ? null : line.match(/^(\d+): ((?:https?|about|chrome|edge|devtools|chrome-extension):\S+)(?: \[selected\])?$/u);
    if (!match && !direct) throw new Error("The persistent Chrome bridge page-list format changed.");
    const id = Number((match || direct)[1]);
    if (!Number.isSafeInteger(id) || id < 0 || ids.has(id)) throw new Error("The persistent Chrome bridge page list contained an invalid or repeated identifier.");
    ids.add(id);
    pages.push({ id, title: (match || direct)[2], url: match ? match[3] : direct[2], selected: line.endsWith(" [selected]") });
  }
  return pages;
}

function collectStrings(value, output = [], seen = new Set()) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, seen);
  } else {
    for (const item of Object.values(value)) collectStrings(item, output, seen);
  }
  return output;
}

function findUniqueUid(snapshot, accessibleName) {
  const matches = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.name === accessibleName && typeof value.id === "string" && value.id) matches.push(value.id);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(snapshot);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new Error(`The extension control '${accessibleName}' was ${unique.length ? "ambiguous" : "not found"}. Reload the unpacked extension and refresh the issue tab.`);
  return unique[0];
}

function findUniqueUidInToolResult(result, accessibleName) {
  if (result?.structuredContent?.snapshot) return findUniqueUid(result.structuredContent.snapshot, accessibleName);
  const matches = [];
  for (const text of collectStrings(result?.content)) {
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/\buid=([^\s]+)\s+[^\s]+\s+("(?:\\.|[^"\\])*")/u);
      if (!match) continue;
      let name;
      try { name = JSON.parse(match[2]); } catch { continue; }
      if (name === accessibleName) matches.push(match[1]);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new Error(`The extension control '${accessibleName}' was ${unique.length ? "ambiguous" : "not found"}. Reload the unpacked extension and refresh the issue tab.`);
  return unique[0];
}

function decodeTerminalMarker(result, requestId, commandName, expected) {
  const prefix = `${RESULT_PREFIX}${requestId}:`;
  const candidates = new Set(collectStrings(result).flatMap((text) => {
    if (text.startsWith(prefix)) return [text];
    const start = text.indexOf(prefix);
    if (start < 0) return [];
    const tail = text.slice(start);
    const match = tail.match(/^TEAL_CLI_RESULT_[A-Za-z0-9_-]{16,80}:[A-Za-z0-9_-]+/u);
    return match ? [match[0]] : [];
  }));
  if (candidates.size !== 1) throw new Error("The persistent bridge returned an ambiguous or missing result marker.");
  const marker = [...candidates][0];
  if (marker.length > MAX_MARKER_LENGTH) throw new Error("The persistent bridge result marker was too large.");
  const encoded = marker.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("The persistent bridge result encoding was invalid.");
  const buffer = Buffer.from(encoded, "base64url");
  if (buffer.toString("base64url") !== encoded) throw new Error("The persistent bridge result encoding was not canonical.");
  let payload;
  try { payload = JSON.parse(buffer.toString("utf8")); } catch { throw new Error("The persistent bridge result was not valid JSON."); }
  const terminalKeys = payload?.state === "completed"
    ? ["protocolVersion", "extensionVersion", "documentId", "requestId", "targetUrl", "command", "state", "result"]
    : ["protocolVersion", "extensionVersion", "documentId", "requestId", "targetUrl", "command", "state", "error"];
  if (!exactKeys(payload, terminalKeys)) throw new Error("The persistent bridge result envelope was invalid.");
  if (payload.protocolVersion !== PERSISTENT_BRIDGE_PROTOCOL_VERSION || payload.extensionVersion !== PERSISTENT_BRIDGE_EXTENSION_VERSION) throw new Error("The persistent bridge result version did not match the CLI.");
  if (!DOCUMENT_PATTERN.test(payload.documentId || "")) throw new Error("The persistent bridge document identifier was invalid.");
  if (expected.documentId && payload.documentId !== expected.documentId) throw new Error("The issue page was refreshed after the persistent bridge session started.");
  if (payload.requestId !== requestId || payload.targetUrl !== expected.targetUrl || payload.command !== commandName) throw new Error("The persistent bridge result was bound to a different request or page.");
  if (payload.state === "failed") {
    const error = new Error(String(payload.error || "The persistent bridge command failed.").slice(0, 2_000));
    error.confirmedTerminal = true;
    throw error;
  }
  if (payload.state !== "completed" || !isPlainObject(payload.result)) throw new Error("The persistent bridge returned no valid completed result.");
  return { payload, result: payload.result };
}

class PersistentBridgeClient {
  constructor(proxyPath, issueIdentifier, options = {}) {
    if (typeof proxyPath !== "string" || !isAbsolute(proxyPath)) throw new Error("The persistent Chrome stdio proxy path must be absolute.");
    this.proxyPath = resolve(proxyPath);
    this.issueIdentifier = issueIdentifier;
    this.sessionOptions = options.sessionOptions || {};
    this.targetId = "";
    this.requestedTargetId = options.targetId || "";
    if (this.requestedTargetId && !TARGET_ID_PATTERN.test(this.requestedTargetId)) throw new Error("The persistent Chrome target identifier was invalid.");
    this.targetUrl = "";
    this.targetTitle = "";
    this.documentId = "";
    this.mode = "persistent";
  }

  async withSession(callback) {
    const session = await McpStdioSession.open(this.proxyPath, this.sessionOptions);
    try { return await callback(session); } finally { await session.close(); }
  }

  async selectExpectedPage(session) {
    const listed = await session.callTool("list_pages", {}, 45_000);
    const pages = parsePageListResult(listed);
    const page = selectAllowedPage(pages, this.issueIdentifier, this.requestedTargetId);
    const pageIdValue = Number(page.id);
    const pageId = String(pageIdValue);
    const pageUrl = String(page.url || "");
    const pageTitle = String(page.title || "");
    if (this.targetId && (pageId !== this.targetId || pageUrl !== this.targetUrl || pageTitle !== this.targetTitle)) throw new Error("The selected issue tab changed after the persistent bridge session started.");
    if (!Number.isSafeInteger(pageIdValue) || pageIdValue < 0) throw new Error("The persistent Chrome bridge returned an invalid page identifier.");
    await session.callTool("select_page", { pageId: pageIdValue, bringToFront: false }, 45_000);
    if (!this.targetId) {
      this.targetId = pageId;
      this.targetUrl = pageUrl;
      this.targetTitle = pageTitle;
    }
  }

  async performTool(name, args, timeoutMs = 70_000) {
    return this.withSession(async (session) => {
      await this.selectExpectedPage(session);
      return session.callTool(name, args, timeoutMs);
    });
  }

  async resolveControlUid(accessibleName) {
    const result = await this.performTool("take_snapshot", { verbose: false }, 70_000);
    return findUniqueUidInToolResult(result, accessibleName);
  }

  createRequestId() {
    const requestId = randomBytes(24).toString("base64url");
    if (!REQUEST_PATTERN.test(requestId)) throw new Error("The CLI could not create a valid request identifier.");
    return requestId;
  }

  envelope(requestId, command, initial = false) {
    return {
      protocolVersion: PERSISTENT_BRIDGE_PROTOCOL_VERSION,
      requestId,
      documentId: initial ? "" : this.documentId,
      targetUrl: this.targetUrl,
      command
    };
  }

  async waitForAccessibleText(text, timeoutMs) {
    return this.performTool("wait_for", { text: [text], timeout: timeoutMs }, Math.max(20_000, timeoutMs + 10_000));
  }

  async confirmDispatchAfterIndeterminate(requestId, deadline) {
    const ack = `${ACK_PREFIX}${requestId}`;
    const ready = `${RESULT_PREFIX}${requestId}`;
    while (Date.now() < deadline) {
      try {
        await this.performTool("wait_for", { text: [ack, ready], timeout: Math.min(1_000, Math.max(1, deadline - Date.now())) }, 20_000);
        return;
      } catch (error) {
        if (!(error instanceof McpToolError) || !/timed out|timeout/i.test(error.message)) throw error;
      }
    }
    const error = new Error("The command dispatch is indeterminate. The CLI did not resend it, and the issue page returned no matching acknowledgement.");
    error.indeterminate = true;
    throw error;
  }

  async waitForTerminalResult(requestId, commandName, timeoutMs) {
    const ready = `${RESULT_PREFIX}${requestId}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = await this.waitForAccessibleText(ready, Math.min(2_000, Math.max(1, deadline - Date.now())));
        return decodeTerminalMarker(result, requestId, commandName, { documentId: this.documentId, targetUrl: this.targetUrl });
      } catch (error) {
        if (error instanceof McpToolError && /timed out|timeout/i.test(error.message)) continue;
        throw error;
      }
    }
    throw new Error(`The persistent bridge did not finish ${commandName} before the CLI timeout.`);
  }

  async callBridge(command, options = {}) {
    if (!isPlainObject(command) || typeof command.command !== "string") throw new Error("The persistent bridge command was invalid.");
    const requestId = this.createRequestId();
    const initial = options.initial === true;
    const commandUid = await this.resolveControlUid(COMMAND_CONTROL_NAME);
    const value = JSON.stringify(this.envelope(requestId, command, initial));
    if (value.length > 262_144) throw new Error("The persistent bridge command was too large.");
    const isApply = command.command === "apply-upload" || command.command === "apply-download" || command.command === "apply-delete";
    const indeterminateOnDispatch = isApply || options.indeterminateOnDispatch === true;
    let dispatched = false;
    try {
      await this.performTool("fill", { uid: commandUid, value, includeSnapshot: false }, Math.max(70_000, value.length * 12));
      dispatched = true;
    } catch (error) {
      try {
        await this.confirmDispatchAfterIndeterminate(requestId, Date.now() + 30_000);
        dispatched = true;
      } catch (confirmationError) {
        if (indeterminateOnDispatch) {
          confirmationError.indeterminate = true;
          confirmationError.message = `The apply dispatch is indeterminate. ${confirmationError.message}`;
          throw confirmationError;
        }
        throw error;
      }
    }
    try {
      return await this.waitForTerminalResult(requestId, command.command, options.timeoutMs || 30_000);
    } catch (error) {
      if (indeterminateOnDispatch && dispatched && error?.confirmedTerminal !== true) {
        error.indeterminate = true;
        error.message = `The apply request may still be running. ${error.message}`;
      }
      throw error;
    }
  }

  async attach() {
    const terminal = await this.callBridge({ command: "capabilities" }, { initial: true, timeoutMs: 30_000 });
    const result = terminal.result;
    if (!exactKeys(result, ["ok", "issueIdentifier", "persistentBridgeProtocolVersion", "extensionVersion", "documentId", "targetUrl"])) throw new Error("The extension returned an invalid persistent bridge capability record.");
    if (result.ok !== true || result.issueIdentifier !== this.issueIdentifier || result.targetUrl !== this.targetUrl) throw new Error("The extension capability record was bound to a different issue page.");
    if (result.persistentBridgeProtocolVersion !== PERSISTENT_BRIDGE_PROTOCOL_VERSION || result.extensionVersion !== PERSISTENT_BRIDGE_EXTENSION_VERSION) throw new Error("The extension and CLI persistent bridge versions do not match.");
    if (!DOCUMENT_PATTERN.test(result.documentId || "") || terminal.payload.documentId !== result.documentId) throw new Error("The extension returned an invalid document generation identifier.");
    this.documentId = result.documentId;
    return this;
  }

  async uploadFiles(filePaths, { beforeFileSelection, afterFileSelection } = {}) {
    if (!Array.isArray(filePaths) || !filePaths.length) throw new Error("apply-upload requires at least one local file path.");
    const resolvedPaths = [];
    const names = [];
    const nameKeys = new Set();
    for (const filePath of filePaths) {
      if (!isAbsolute(filePath)) throw new Error("Upload paths must be absolute local file paths.");
      const absolute = resolve(filePath);
      const stat = await lstat(absolute).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`The upload path was not a safe regular file: ${absolute}`);
      const name = basename(absolute);
      const key = name.toLocaleLowerCase("en-US");
      if (nameKeys.has(key)) throw new Error(`The upload file list contained a repeated filename: ${name}`);
      nameKeys.add(key);
      resolvedPaths.push(absolute);
      names.push(name);
    }
    const prepared = await this.callBridge({ command: "prepare-upload" }, { timeoutMs: 30_000 });
    if (prepared.result?.ok !== true) throw new Error(prepared.result?.error || "The extension did not prepare the CLI upload selection.");
    try {
      for (const filePath of resolvedPaths) {
        const uploadUid = await this.resolveControlUid(UPLOAD_CONTROL_NAME);
        if (typeof beforeFileSelection === "function") await beforeFileSelection(filePath);
        await this.performTool("upload_file", { uid: uploadUid, filePath, includeSnapshot: false }, 70_000);
        if (typeof afterFileSelection === "function") await afterFileSelection(filePath);
      }
      return names;
    } catch (error) {
      try { await this.callBridge({ command: "cancel-upload" }, { timeoutMs: 30_000 }); } catch { }
      throw error;
    }
  }

  async close() {
    // Every action owns a short stdio proxy session. The shared daemon stays open.
  }
}

export {
  ACK_PREFIX,
  COMMAND_CONTROL_NAME,
  EXPECTED_GATEWAY_TOOLS,
  McpRpcError,
  McpStdioSession,
  McpToolError,
  PERSISTENT_BRIDGE_EXTENSION_VERSION,
  PERSISTENT_BRIDGE_PROTOCOL_VERSION,
  PersistentBridgeClient,
  RESULT_PREFIX,
  UPLOAD_CONTROL_NAME,
  decodeTerminalMarker,
  findUniqueUid,
  findUniqueUidInToolResult,
  issueFromTargetUrl,
  parsePageListResult,
  sanitizeDiagnosticText,
  sanitizeStructuredData,
  proxyCloseError,
  sanitizedPageDescriptors,
  selectAllowedPage
};
