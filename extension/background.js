"use strict";

const SAVE_ZIP_MESSAGE = "teal-eval-bulk-save-zip-v1";
const ZIP_TERMINAL_MESSAGE = "teal-eval-bulk-zip-terminal-v1";
const COMMAND_REQUEST_MESSAGE = "teal-eval-bulk-command-v1";
const COMMAND_EXECUTE_MESSAGE = "teal-eval-bulk-command-execute-v1";
const NATIVE_DELETE_MESSAGE = "teal-eval-bulk-native-delete-v1";
const ISSUE_PATH_PATTERN = /^\/issue\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DOWNLOAD_STORAGE_PREFIX = "tealZipDownload:";
const ALLOWED_COMMANDS = new Set(["capabilities", "status", "list", "prepare-upload", "cancel-upload", "plan-upload", "apply-upload", "plan-download", "apply-download", "plan-delete", "apply-delete", "stop"]);

function validateFilename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value);
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

// Only exact http(s) origins with the literal /issue/* path are trusted.
// Wildcards, <all_urls>, and non-issue paths create no allowed origin.
function allowedIssueOriginsFromManifest(manifest = chrome.runtime.getManifest()) {
  const origins = new Set();
  const scripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [];
  for (const script of scripts) {
    const matches = Array.isArray(script?.matches) ? script.matches : [];
    for (const match of matches) {
      if (typeof match !== "string") continue;
      const parts = match.match(/^(https?):\/\/([^/?#*]+)\/issue\/\*$/i);
      if (!parts) continue;
      try {
        const parsed = new URL(match);
        if (parsed.protocol !== `${parts[1].toLowerCase()}:` || parsed.pathname !== "/issue/*" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.hostname.includes("*") || !parsed.hostname) continue;
        origins.add(parsed.origin);
      } catch {
        // Invalid values do not create an allowed origin.
      }
    }
  }
  return origins;
}

function issueContextFromUrl(url, origins = allowedIssueOriginsFromManifest()) {
  try {
    const parsed = new URL(url);
    if (!origins.has(parsed.origin)) return null;
    // Production has no loopback match. This remains fail-closed if a broad
    // match is ever added by mistake because only the exact origin is accepted.
    if (isLoopbackHostname(parsed.hostname) && !origins.has(parsed.origin)) return null;
    const issueIdentifier = (parsed.pathname.match(ISSUE_PATH_PATTERN)?.[1] || "").toUpperCase();
    if (!issueIdentifier || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    return { issueIdentifier, origin: parsed.origin };
  } catch {
    return null;
  }
}

function issueIdentifierFromUrl(url, origins = allowedIssueOriginsFromManifest()) {
  return issueContextFromUrl(url, origins)?.issueIdentifier || "";
}

function senderIssueContext(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return null;
  return issueContextFromUrl(sender.tab.url || sender.url || "");
}

function senderIssueIdentifier(sender) {
  return senderIssueContext(sender)?.issueIdentifier || "";
}

function validateBlobUrl(value, expectedOrigin) {
  if (typeof value !== "string" || value.length > 1_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "blob:" && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) return "The ZIP file list was invalid.";
  const ids = new Set();
  const names = new Set();
  const keys = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return "A ZIP file entry was invalid.";
    if (!UUID_PATTERN.test(entry.stagedId || "")) return "A staged-file ID was invalid.";
    if (!validateFilename(entry.filename)) return "A staged filename was not safe to save.";
    if (!SHA256_PATTERN.test(entry.sha256 || "")) return "A staged-file SHA-256 value was invalid.";
    const nameKey = entry.filename.toLocaleLowerCase("en-US");
    const rowKey = JSON.stringify([entry.filename, entry.sha256.toLowerCase()]);
    if (ids.has(entry.stagedId) || names.has(nameKey) || keys.has(rowKey)) return "The ZIP file list contained a repeated entry or filename.";
    ids.add(entry.stagedId);
    names.add(nameKey);
    keys.add(rowKey);
  }
  return "";
}

function validateSaveMessage(message, sender, senderContext = senderIssueContext(sender)) {
  if (!senderContext) return "The Save As request did not come from the top frame of an allowed issue page.";
  if (!message || typeof message !== "object") return "The Save As request was missing.";
  if (!TOKEN_PATTERN.test(message.requestId || "")) return "The Save As request ID was invalid.";
  if (!TOKEN_PATTERN.test(message.batchId || "")) return "The Save As batch ID was invalid.";
  if (message.sequence !== 0) return "The Save As sequence was invalid.";
  if (message.issueIdentifier !== senderContext.issueIdentifier) return "The Save As issue identifier did not match this page.";
  if (!validateFilename(message.archiveFilename) || !message.archiveFilename.toLowerCase().endsWith(".zip")) return "The ZIP filename was not safe to save.";
  if (!validateBlobUrl(message.blobUrl, senderContext.origin)) return "The ZIP data URL was invalid.";
  return validateEntries(message.entries);
}

function validateCommandMessage(message, sender) {
  const senderIssue = senderIssueIdentifier(sender);
  if (!senderIssue) return "The command did not come from the top frame of an allowed issue page.";
  if (!message || typeof message !== "object" || message.type !== COMMAND_REQUEST_MESSAGE) return "The command was invalid.";
  const allowedKeys = new Set(["type", "command", "issueIdentifier", "names", "authorizationId"]);
  if (!Object.keys(message).every((key) => allowedKeys.has(key))) return "The command contained an unsupported field.";
  if (!ALLOWED_COMMANDS.has(message.command)) return "The command was not allowed.";
  if (message.issueIdentifier !== senderIssue) return "The command issue identifier did not match this page.";
  const needsNames = ["plan-upload", "apply-upload", "plan-download", "apply-download", "plan-delete", "apply-delete"].includes(message.command);
  const needsAuthorization = ["apply-upload", "apply-download", "apply-delete"].includes(message.command);
  if (!needsNames && Object.prototype.hasOwnProperty.call(message, "names")) return "This command cannot include names.";
  if (needsNames && (!Array.isArray(message.names) || message.names.length === 0 || message.names.length > 500 || !message.names.every(validateFilename))) return "The command names were invalid.";
  if (needsAuthorization && !TOKEN_PATTERN.test(message.authorizationId || "")) return "The CLI plan authorization was invalid.";
  if (!needsAuthorization && Object.prototype.hasOwnProperty.call(message, "authorizationId")) return "This command cannot include a CLI plan authorization.";
  return "";
}

function validateNativeDeleteMessage(message, sender) {
  const senderIssue = senderIssueIdentifier(sender);
  if (!senderIssue) return "The deletion request did not come from the top frame of an allowed issue page.";
  if (!message || typeof message !== "object" || message.type !== NATIVE_DELETE_MESSAGE) return "The deletion request was invalid.";
  const allowedKeys = new Set(["type", "issueIdentifier", "filename", "sha256"]);
  if (!Object.keys(message).every((key) => allowedKeys.has(key))) return "The deletion request contained an unsupported field.";
  if (message.issueIdentifier !== senderIssue) return "The deletion issue identifier did not match this page.";
  if (!validateFilename(message.filename) || !SHA256_PATTERN.test(message.sha256 || "")) return "The deletion target was invalid.";
  return "";
}

async function fetchJson(origin, path) {
  const response = await fetch(`${origin}${path}`, { method: "GET", headers: { Accept: "application/json" }, credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `The file service returned ${response.status}.`);
  return payload;
}

function startSaveAs(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" }, (id) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message || "The browser did not start the ZIP download."));
      if (!Number.isInteger(id)) return reject(new Error("The browser did not return a ZIP download ID."));
      resolve(id);
    });
  });
}

function downloadStorageKey(downloadId) { return `${DOWNLOAD_STORAGE_PREFIX}${downloadId}`; }

async function notifyTerminal(downloadId, state, errorMessage = "") {
  const key = downloadStorageKey(downloadId);
  const stored = await chrome.storage.session.get(key);
  const pending = stored?.[key];
  if (!pending || !Number.isInteger(pending.tabId) || typeof pending.requestId !== "string") return;
  try {
    await chrome.tabs.sendMessage(pending.tabId, { type: ZIP_TERMINAL_MESSAGE, requestId: pending.requestId, downloadId, ok: state === "complete", error: state === "complete" ? "" : (errorMessage || "The browser interrupted the ZIP download.") }, { frameId: 0 });
  } catch {
    // The issue page can close after the browser starts the download.
  } finally {
    await chrome.storage.session.remove(key);
  }
}

function checkTerminalState(downloadId) {
  chrome.downloads.search({ id: downloadId }, (items) => {
    if (chrome.runtime.lastError) return;
    const item = Array.isArray(items) ? items[0] : null;
    if (item?.state === "complete" || item?.state === "interrupted") void notifyTerminal(downloadId, item.state);
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted" || delta.error?.current) void notifyTerminal(delta.id, delta.state?.current === "complete" ? "complete" : "interrupted");
});

async function verifyEntries(message, origin) {
  const listPayload = await fetchJson(origin, `/api/staged-files?issue_identifier=${encodeURIComponent(message.issueIdentifier)}`);
  if (!Array.isArray(listPayload.rows)) throw new Error("The staged-file API did not return a file list.");
  for (const entry of message.entries) {
    const matches = listPayload.rows.filter((row) => row && typeof row === "object" && String(row.id) === entry.stagedId && row.filename === entry.filename && String(row.sha256 || "").toLowerCase() === entry.sha256.toLowerCase());
    if (matches.length !== 1) throw new Error(`The file service could not verify exactly one copy of ${entry.filename}.`);
  }
}

async function beginVerifiedSaveAs(message, sender, origin) {
  await verifyEntries(message, origin);
  const downloadId = await startSaveAs(message.blobUrl, message.archiveFilename);
  try {
    await chrome.storage.session.set({ [downloadStorageKey(downloadId)]: { tabId: sender.tab.id, requestId: message.requestId } });
  } catch (error) {
    return {
      ok: false,
      started: true,
      indeterminate: true,
      requestId: message.requestId,
      downloadId,
      error: `The browser started the ZIP download, but the extension could not track its final state. ${error instanceof Error ? error.message : String(error)}`
    };
  }
  checkTerminalState(downloadId);
  return { ok: true, started: true, requestId: message.requestId, downloadId };
}

// Serialized by chrome.scripting: no closure, no persistent MAIN-world bridge.
function clickNativeDeleteOnce(filename, sha256) {
  const removePrompt = "Remove this staged file? Active runs may still reference it.";
  const markerName = "__tealEvalBulkNativeDeleteInFlightV09__";
  const originalConfirm = window.confirm;
  const previousMarker = window[markerName];
  const prompts = [];
  try {
    if (previousMarker) return { ok: false, code: "already_in_flight", promptCalls: 0 };
    window[markerName] = true;
    window.confirm = (message) => {
      prompts.push(String(message));
      return prompts.length === 1 && message === removePrompt;
    };
    const matches = [...document.querySelectorAll("table tbody tr")].filter((row) => {
      const cells = row.querySelectorAll("td");
      const rowFilename = cells[0]?.textContent?.trim() || "";
      const hashElement = cells[2]?.querySelector("[title]");
      const rowHash = hashElement?.getAttribute("title") || cells[2]?.textContent?.trim() || "";
      const removeButton = [...row.querySelectorAll("button")].find((button) => button.textContent?.trim() === "remove");
      return rowFilename === filename && rowHash === sha256 && removeButton;
    });
    if (matches.length !== 1) return { ok: false, code: "target_not_unique", promptCalls: prompts.length };
    const removeButton = [...matches[0].querySelectorAll("button")].find((button) => button.textContent?.trim() === "remove");
    if (!removeButton) return { ok: false, code: "remove_control_missing", promptCalls: prompts.length };
    removeButton.click();
    if (prompts.length === 0) return { ok: false, code: "no_prompt", promptCalls: 0 };
    if (prompts.length !== 1) return { ok: false, code: "repeated_prompt", promptCalls: prompts.length };
    if (prompts[0] !== removePrompt) return { ok: false, code: "wrong_prompt", promptCalls: 1 };
    return { ok: true, code: "ok", promptCalls: 1 };
  } catch (error) {
    return { ok: false, code: "click_error", promptCalls: prompts.length, error: error instanceof Error ? error.message : String(error) };
  } finally {
    window.confirm = originalConfirm;
    if (previousMarker === undefined) delete window[markerName];
    else window[markerName] = previousMarker;
  }
}

function validateNativeDeleteResult(result) {
  if (result && result.ok === true && result.code === "ok" && result.promptCalls === 1) return { ok: true };
  const code = typeof result?.code === "string" ? result.code : "invalid_result";
  const detail = typeof result?.error === "string" && result.error ? `: ${result.error}` : "";
  return { ok: false, error: `Native deletion was not confirmed exactly once (${code})${detail}.`, code };
}

async function performNativeDelete(message, sender) {
  const validationError = validateNativeDeleteMessage(message, sender);
  if (validationError) return { ok: false, error: validationError, code: "validation" };
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [0] }, world: "MAIN", func: clickNativeDeleteOnce, args: [message.filename, message.sha256] });
    if (!Array.isArray(results) || results.length !== 1) return { ok: false, error: "Native deletion returned no single result.", code: "result_count" };
    return validateNativeDeleteResult(results[0]?.result);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: "injection" };
  }
}

async function routeCommand(message, sender) {
  const validationError = validateCommandMessage(message, sender);
  if (validationError) return { ok: false, error: validationError };
  const isApply = ["apply-upload", "apply-download", "apply-delete"].includes(message.command);
  try {
    const execution = { type: COMMAND_EXECUTE_MESSAGE, command: message.command, issueIdentifier: message.issueIdentifier };
    if (Object.prototype.hasOwnProperty.call(message, "names")) execution.names = [...message.names];
    if (Object.prototype.hasOwnProperty.call(message, "authorizationId")) execution.authorizationId = message.authorizationId;
    const result = await chrome.tabs.sendMessage(sender.tab.id, execution, { frameId: 0 });
    if (result && typeof result === "object") return result;
    return isApply
      ? { ok: false, indeterminate: true, error: `The ${message.command} command was dispatched, but the isolated controller returned no final result. The operation may still be running.` }
      : { ok: false, error: "The isolated controller returned no result." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return isApply
      ? { ok: false, indeterminate: true, error: `The ${message.command} command was dispatched, but its response channel failed. The operation may still be running. ${detail}` }
      : { ok: false, error: detail };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === SAVE_ZIP_MESSAGE) {
    const senderContext = senderIssueContext(sender);
    const validationError = validateSaveMessage(message, sender, senderContext);
    if (validationError) {
      sendResponse({ ok: false, requestId: message?.requestId || "", error: validationError });
      return false;
    }
    beginVerifiedSaveAs(message, sender, senderContext.origin)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === COMMAND_REQUEST_MESSAGE) {
    routeCommand(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === NATIVE_DELETE_MESSAGE) {
    performNativeDelete(message, sender).then(sendResponse);
    return true;
  }
  return false;
});
