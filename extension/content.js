(() => {
  "use strict";

  const EXTENSION_ID = "teal-eval-bulk-files-v1";
  const HOST_ID = `${EXTENSION_ID}-host`;
  const BUTTON_ID = `${EXTENSION_ID}-button`;
  const REMOVE_PROMPT = "Remove this staged file? Active runs may still reference it.";
  const ISSUE_PATTERN = /^\/issue\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/;
  const UPLOAD_START_TIMEOUT_MS = 10_000;
  const UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const UPLOAD_READY_STABLE_MS = 500;
  const UPLOAD_SETTLE_STABLE_MS = 1_500;
  const UPLOAD_SETTLE_TIMEOUT_MS = 30_000;
  const DELETE_TIMEOUT_MS = 60_000;
  const DELETE_LIST_READY_TIMEOUT_MS = 15_000;
  const DELETE_LIST_STABLE_MS = 400;
  const DELETE_GRACE_PERIOD_SECONDS = 5;
  const DOWNLOAD_LIST_READY_TIMEOUT_MS = 15_000;
  const DOWNLOAD_BRIDGE_TIMEOUT_MS = 5_000;
  const DOWNLOAD_SAVE_AS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const INDETERMINATE_BLOB_RETENTION_MS = 15 * 60 * 1000;
  const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
  const MAX_ARCHIVE_FILE_BYTES = 256 * 1024 * 1024;
  const SAVE_ZIP_MESSAGE = "teal-eval-bulk-save-zip-v1";
  const ZIP_TERMINAL_MESSAGE = "teal-eval-bulk-zip-terminal-v1";
  const COMMAND_REQUEST_MESSAGE = "teal-eval-bulk-command-v1";
  const COMMAND_EXECUTE_MESSAGE = "teal-eval-bulk-command-execute-v1";
  const NATIVE_DELETE_MESSAGE = "teal-eval-bulk-native-delete-v1";
  const BRIDGE_GLOBAL = "__TEAL_EVAL_BULK_V09_BRIDGE__";
  const BRIDGE_PLAN_TTL_MS = 60 * 60 * 1000;
  const BRIDGE_AUTHORIZATION_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
  const PERSISTENT_BRIDGE_PROTOCOL_VERSION = 1;
  const PERSISTENT_BRIDGE_EXTENSION_VERSION = "0.9.4";
  const PERSISTENT_BRIDGE_REQUEST_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
  const PERSISTENT_BRIDGE_UPLOAD_TTL_MS = 5 * 60 * 1000;
  const PERSISTENT_BRIDGE_RESULT_TTL_MS = 15 * 60 * 1000;
  const PERSISTENT_BRIDGE_MAX_REQUESTS = 4096;
  const PERSISTENT_BRIDGE_MAX_RESULT_BYTES = 512 * 1024;
  const PERSISTENT_BRIDGE_RESULT_PREFIX = "TEAL_CLI_RESULT_";
  const PERSISTENT_BRIDGE_ACK_PREFIX = "TEAL_CLI_ACK_";

  if (document.getElementById(HOST_ID)) {
    return;
  }

  const issueMatch = window.location.pathname.match(ISSUE_PATTERN);
  if (!issueMatch) {
    return;
  }

  const issueIdentifier = issueMatch[1].toUpperCase();
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  document.documentElement.appendChild(host);

  // Keep the controls and the approval surface outside the page's script reach.
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color-scheme: dark;
        --eval-bg: var(--bg, #101012);
        --eval-surface: var(--surface, #111113);
        --eval-text: var(--text, #e8e8e8);
        --eval-muted: var(--muted, #6b6f76);
        --eval-placeholder: var(--placeholder, #434549);
        --eval-border: var(--border, #252528);
        --eval-accent: var(--accent, #7180ff);
        --eval-accent-hover: var(--accent-hover, #8a97ff);
        --eval-accent-bg: var(--accent-bg, #7180ff1a);
        --eval-danger: var(--danger, #eb5757);
        --eval-warning: var(--warning, #f2a93b);
        --eval-success: var(--success, #4cb782);
      }
      *, *::before, *::after { box-sizing: border-box; }
      .backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.72);
        pointer-events: auto;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
        color: var(--eval-text);
      }
      .backdrop.open { display: flex; }
      .dialog {
        width: min(760px, 100%);
        height: min(700px, calc(100vh - 24px));
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: var(--eval-surface);
        border: 1px solid var(--eval-border);
        border-radius: 10px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.62);
      }
      .header {
        display: flex;
        gap: 18px;
        align-items: flex-start;
        justify-content: space-between;
        padding: 18px 20px 14px;
        border-bottom: 1px solid var(--eval-border);
      }
      h1 { margin: 0; font-size: 18px; line-height: 1.3; color: var(--eval-text); }
      .subtitle { margin-top: 3px; color: var(--eval-muted); font-size: 12px; }
      .close {
        border: 0;
        background: transparent;
        color: var(--eval-muted);
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
        padding: 0 2px 3px;
      }
      .close:hover { color: var(--eval-text); }
      .close:disabled { cursor: not-allowed; opacity: 0.4; }
      .body {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) 58px;
        gap: 12px;
        padding: 16px 20px 20px;
        overflow: hidden;
        background: var(--eval-surface);
      }
      .tabs { display: flex; gap: 8px; }
      .tab {
        border: 1px solid var(--eval-border);
        background: var(--eval-bg);
        color: var(--eval-text);
        border-radius: 7px;
        padding: 7px 12px;
        font-size: 13px;
        font-weight: 650;
        cursor: pointer;
      }
      .tab:hover { border-color: var(--eval-accent); }
      .tab.active { border-color: var(--eval-accent); background: var(--eval-accent-bg); color: var(--eval-accent-hover); }
      .mode-stage {
        min-height: 0;
        overflow: auto;
        scrollbar-gutter: stable;
      }
      .panel { display: none; }
      .panel.active {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-rows: 58px minmax(0, 1fr) 34px auto;
        gap: 8px;
      }
      .notice {
        height: 58px;
        padding: 10px 12px;
        overflow: auto;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--eval-warning) 55%, var(--eval-border));
        background: color-mix(in srgb, var(--eval-warning) 10%, var(--eval-surface));
        color: color-mix(in srgb, var(--eval-warning) 78%, var(--eval-text));
        font-size: 12px;
        line-height: 1.45;
      }
      .notice.danger {
        border-color: color-mix(in srgb, var(--eval-danger) 55%, var(--eval-border));
        background: color-mix(in srgb, var(--eval-danger) 10%, var(--eval-surface));
        color: color-mix(in srgb, var(--eval-danger) 82%, var(--eval-text));
      }
      .drop-zone {
        grid-row: 2;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 5px;
        align-items: center;
        justify-content: center;
        padding: 20px;
        border: 1px dashed color-mix(in srgb, var(--eval-accent) 58%, var(--eval-border));
        border-radius: 9px;
        background: color-mix(in srgb, var(--eval-accent) 4%, var(--eval-bg));
        cursor: pointer;
        text-align: center;
        transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
      }
      .drop-zone:hover,
      .drop-zone.drag-over {
        border-color: var(--eval-accent);
        background: var(--eval-accent-bg);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--eval-accent) 22%, transparent);
      }
      .drop-zone.busy { cursor: not-allowed; opacity: 0.58; }
      .drop-zone:focus-visible { outline: 2px solid var(--eval-accent); outline-offset: 3px; }
      .drop-icon { width: 30px; height: 30px; color: var(--eval-accent); }
      .drop-icon svg { display: block; width: 100%; height: 100%; }
      .drop-title { color: var(--eval-text); font-size: 14px; font-weight: 700; }
      .drop-subtitle, .drop-help { color: var(--eval-muted); font-size: 11px; }
      input[type="file"] { display: none; }
      .current-list {
        min-height: 0;
        margin: 0;
        border: 1px solid var(--eval-border);
        border-radius: 8px;
        overflow: auto;
        background: var(--eval-bg);
      }
      .file-list {
        display: none;
        width: min(100%, 620px);
        max-height: 110px;
        overflow: auto;
        background: transparent;
        text-align: left;
      }
      .file-list.has-files { display: block; }
      .file-list .row { padding: 4px 6px; }
      .current-list { grid-row: 2; height: 100%; }
      .upload-actions, .download-actions, .delete-actions { grid-row: 4; align-self: end; }
      .download-toolbar, .delete-toolbar { grid-row: 3; align-self: center; }
      .empty { padding: 16px; color: var(--eval-muted); font-size: 12px; text-align: center; }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 8px 10px;
        border-top: 1px solid var(--eval-border);
        font-size: 12px;
      }
      .row:first-child { border-top: 0; }
      .select-row { grid-template-columns: auto minmax(0, 1fr) auto; }
      .name { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--eval-text); }
      .meta { color: var(--eval-muted); white-space: nowrap; }
      .bad { color: var(--eval-danger); font-weight: 650; }
      .skip { color: var(--eval-warning); font-weight: 650; }
      .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .controls.spread { justify-content: space-between; }
      button.action {
        border: 1px solid var(--eval-accent);
        background: var(--eval-accent);
        color: #fff;
        border-radius: 7px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      button.action:hover:not(:disabled) { background: var(--eval-accent-hover); }
      button.action.secondary { border-color: var(--eval-border); background: var(--eval-bg); color: var(--eval-text); }
      button.action.secondary:hover:not(:disabled) { border-color: var(--eval-accent); background: var(--eval-accent-bg); }
      button.action.danger { border-color: var(--eval-danger); background: var(--eval-danger); }
      button.action.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--eval-danger) 82%, white); }
      button.action.stop-delete:not(:disabled) { border-color: var(--eval-danger); color: var(--eval-danger); }
      button.action:disabled { cursor: not-allowed; opacity: 0.48; }
      label.ack { grid-row: 3; align-self: center; display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 12px; line-height: 1.4; color: var(--eval-text); }
      input[type="checkbox"] { margin-top: 2px; accent-color: var(--eval-accent); }
      .status {
        height: 58px;
        min-height: 58px;
        visibility: hidden;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--eval-border);
        background: var(--eval-accent-bg);
        color: var(--eval-text);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow: auto;
      }
      .status.show { visibility: visible; }
      .status.error { border-color: var(--eval-danger); background: color-mix(in srgb, var(--eval-danger) 11%, var(--eval-surface)); color: color-mix(in srgb, var(--eval-danger) 82%, var(--eval-text)); }
      .status.success { border-color: var(--eval-success); background: color-mix(in srgb, var(--eval-success) 11%, var(--eval-surface)); color: color-mix(in srgb, var(--eval-success) 82%, var(--eval-text)); }
      .small { color: var(--eval-muted); font-size: 11px; line-height: 1.4; }
      .confirm-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.78);
        pointer-events: auto;
      }
      .confirm-backdrop.open { display: flex; }
      .confirm-dialog {
        width: min(620px, 100%);
        max-height: min(680px, calc(100vh - 32px));
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px;
        overflow: hidden;
        border: 1px solid var(--eval-border);
        border-radius: 10px;
        background: var(--eval-surface);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.62);
      }
      .confirm-dialog h2 { margin: 0; font-size: 17px; line-height: 1.3; }
      .confirm-copy { margin: 0; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
      .confirm-list { margin: 0; padding: 10px 12px 10px 28px; overflow: auto; border: 1px solid var(--eval-border); border-radius: 7px; background: var(--eval-bg); font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .confirm-list li { overflow-wrap: anywhere; }
      .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .cli-bridge-surface {
        position: fixed;
        top: 0;
        left: 0;
        width: 2px;
        height: 2px;
        overflow: hidden;
        opacity: 0.001;
        pointer-events: none;
      }
      .cli-bridge-surface input[type="file"],
      .cli-bridge-surface textarea,
      .cli-bridge-surface output {
        display: block;
        position: absolute;
        width: 1px;
        height: 1px;
        min-width: 1px;
        min-height: 1px;
        margin: 0;
        padding: 0;
        border: 0;
        overflow: hidden;
      }
      .cli-bridge-surface textarea { top: 1px; resize: none; }
      .cli-bridge-results { position: absolute; top: 0; left: 1px; width: 1px; height: 1px; overflow: hidden; }
      @media (max-height: 600px) {
        .backdrop { padding: 8px; }
        .dialog { height: calc(100vh - 16px); }
        .header { padding: 12px 16px 10px; }
        .body {
          grid-template-rows: auto minmax(0, 1fr) 42px;
          gap: 8px;
          padding: 10px 16px 12px;
        }
        .tabs { gap: 6px; }
        .tab { padding: 6px 10px; }
        .panel.active {
          grid-template-rows: 54px minmax(0, 1fr) 28px auto;
          gap: 6px;
        }
        .notice { height: 54px; padding: 7px 10px; }
        .drop-zone { padding: 8px; gap: 3px; }
        .drop-icon { width: 22px; height: 22px; }
        .drop-subtitle { display: none; }
        button.action { padding: 6px 10px; }
        .status { height: 42px; min-height: 42px; padding: 7px 10px; }
      }
    </style>
    <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="teal-bulk-title">
      <div class="dialog">
        <div class="header">
          <div>
            <h1 id="teal-bulk-title">Bulk staged files</h1>
            <div class="subtitle">${escapeHtml(issueIdentifier)} · Teal Alpha eval page</div>
          </div>
          <button class="close" type="button" aria-label="Close">×</button>
        </div>
        <div class="body">
          <div class="tabs" role="tablist">
            <button class="tab active" type="button" data-tab="upload">Upload loose files</button>
            <button class="tab" type="button" data-tab="download">Download staged files</button>
            <button class="tab" type="button" data-tab="delete">Delete staged files</button>
          </div>

          <div class="mode-stage">
            <section class="panel active" data-panel="upload">
            <div class="notice">
              The Teal page posts one Linear comment when it finalizes each uploaded file. This extension uploads files one at a time through the page's existing control.
            </div>
            <div class="drop-zone" role="button" tabindex="0" aria-label="Drop loose files here or choose files">
              <input class="bulk-input" type="file" multiple aria-label="Choose loose files to upload">
              <div class="drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3v11"></path><path d="m7.5 10 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path>
                </svg>
              </div>
              <div class="drop-title">Drop loose files here</div>
              <div class="drop-subtitle">or</div>
              <button class="action secondary choose-files" type="button">Choose files</button>
              <div class="drop-help">Multiple files are supported. Folders are not.</div>
              <div class="file-list"></div>
            </div>
            <label class="ack">
              <input class="upload-ack" type="checkbox">
              <span>I understand that the Teal platform will post one Linear comment for each successfully finalized file.</span>
            </label>
            <div class="controls upload-actions">
              <button class="action upload" type="button" disabled>Upload selected files</button>
              <button class="action secondary stop" data-stop-mode="upload" type="button" disabled>Stop after current file</button>
            </div>
            </section>

            <section class="panel" data-panel="download">
            <div class="notice">
              All selected files are placed in one ZIP. Edge opens one Save As dialog for that ZIP.
            </div>
            <div class="current-list download-list"><div class="empty">Reading staged files...</div></div>
            <div class="controls spread download-toolbar">
              <div class="controls">
                <button class="action secondary download-select-all" type="button">Select all</button>
                <button class="action secondary download-select-none" type="button">Select none</button>
              </div>
              <button class="action secondary download-refresh" type="button">Refresh list</button>
            </div>
            <div class="controls download-actions">
              <button class="action start-download" type="button" disabled>Download selected files as ZIP</button>
              <button class="action secondary stop" data-stop-mode="download" type="button" disabled>Stop after current file</button>
            </div>
            </section>

            <section class="panel" data-panel="delete">
            <div class="notice danger">
              Deletion cannot be undone. Active runs can still reference staged files. The extension will show the exact selection, then give you five seconds to stop before it deletes anything.
            </div>
            <div class="current-list delete-list"><div class="empty">Reading staged files…</div></div>
            <div class="controls spread delete-toolbar">
              <div class="controls">
                <button class="action secondary select-all" type="button">Select all</button>
                <button class="action secondary select-none" type="button">Select none</button>
              </div>
              <button class="action secondary refresh" type="button">Refresh list</button>
            </div>
            <div class="controls delete-actions">
              <button class="action danger delete" type="button" disabled>Delete selected files</button>
              <button class="action secondary stop stop-delete" data-stop-mode="delete" type="button" disabled>Stop deletion</button>
            </div>
            </section>
          </div>

          <div class="status" role="status" aria-live="polite"></div>
        </div>
      </div>
    </div>
    <div class="confirm-backdrop" role="presentation">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="teal-bulk-confirm-title" aria-describedby="teal-bulk-confirm-copy">
        <h2 id="teal-bulk-confirm-title">Confirm batch action</h2>
        <p class="confirm-copy" id="teal-bulk-confirm-copy"></p>
        <ul class="confirm-list"></ul>
        <div class="confirm-actions">
          <button class="action secondary confirm-cancel" type="button">Cancel</button>
          <button class="action confirm-apply" type="button">Confirm</button>
        </div>
      </section>
    </div>
    <section class="cli-bridge-surface" aria-label="Teal CLI persistent bridge" tabindex="-1">
      <input class="cli-bridge-upload" type="file" aria-label="Teal CLI persistent upload" tabindex="-1">
      <textarea class="cli-bridge-command" maxlength="262144" aria-label="Teal CLI persistent command" tabindex="-1"></textarea>
      <div class="cli-bridge-results" aria-label="Teal CLI persistent results"></div>
    </section>
  `;

  const ui = {
    backdrop: shadow.querySelector(".backdrop"),
    close: shadow.querySelector(".close"),
    tabs: [...shadow.querySelectorAll(".tab")],
    panels: [...shadow.querySelectorAll(".panel")],
    dropZone: shadow.querySelector(".drop-zone"),
    chooseButton: shadow.querySelector(".choose-files"),
    fileInput: shadow.querySelector(".bulk-input"),
    fileList: shadow.querySelector(".file-list"),
    uploadAck: shadow.querySelector(".upload-ack"),
    uploadButton: shadow.querySelector(".upload"),
    currentList: shadow.querySelector(".delete-list"),
    deleteButton: shadow.querySelector(".delete"),
    selectAll: shadow.querySelector(".select-all"),
    selectNone: shadow.querySelector(".select-none"),
    refresh: shadow.querySelector(".refresh"),
    downloadList: shadow.querySelector(".download-list"),
    downloadButton: shadow.querySelector(".start-download"),
    downloadSelectAll: shadow.querySelector(".download-select-all"),
    downloadSelectNone: shadow.querySelector(".download-select-none"),
    downloadRefresh: shadow.querySelector(".download-refresh"),
    stopDelete: shadow.querySelector(".stop-delete"),
    stopButtons: [...shadow.querySelectorAll(".stop")],
    status: shadow.querySelector(".status"),
    confirmBackdrop: shadow.querySelector(".confirm-backdrop"),
    confirmTitle: shadow.querySelector("#teal-bulk-confirm-title"),
    confirmCopy: shadow.querySelector(".confirm-copy"),
    confirmList: shadow.querySelector(".confirm-list"),
    confirmCancel: shadow.querySelector(".confirm-cancel"),
    confirmApply: shadow.querySelector(".confirm-apply"),
    bridgeUploadInput: shadow.querySelector(".cli-bridge-upload"),
    bridgeCommandInput: shadow.querySelector(".cli-bridge-command"),
    bridgeResults: shadow.querySelector(".cli-bridge-results")
  };

  let busy = false;
  let stopAfterCurrent = false;
  let deleteStopRequested = false;
  let selectedUploads = [];
  let stagedRows = [];
  let selectedDeleteKeys = new Set();
  let selectedDownloadKeys = new Set();
  let ambiguousRowKeys = new Set();
  let currentTab = "upload";
  let dragDepth = 0;
  let pendingConfirmation = null;
  let activeOperation = "";
  let bridgeUploadSelectionActive = false;
  let bridgeUploadSelectionTimer = 0;
  const bridgeDocumentId = createBridgeAuthorizationId();
  const persistentBridgeRequests = new Map();
  const pendingZipRequests = new Map();
  const retainedIndeterminateBlobUrls = new Map();
  const bridgePlanStore = globalThis.TealEvalBridgePlanStore.createStore({
    ttlMs: BRIDGE_PLAN_TTL_MS,
    authorizationPattern: BRIDGE_AUTHORIZATION_PATTERN,
    createAuthorizationId: createBridgeAuthorizationId,
    now: () => Date.now(),
    getInventory: () => publicInventory(),
    parseNames: (names) => parseBridgeNames(names)
  });

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function rowKey(row) {
    return JSON.stringify([row.filename, row.sha256 || ""]);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function findNativePanel() {
    const headings = [...document.querySelectorAll("strong")]
      .filter((element) => element.textContent?.trim() === "Staged files");

    for (const heading of headings) {
      const header = heading.parentElement;
      const container = header?.parentElement;
      const nativeInput = [...(header?.querySelectorAll('input[type="file"]') || [])]
        .find((input) => input !== ui.fileInput);
      const nativeAddButton = [...(header?.querySelectorAll("button") || [])]
        .find((button) => button.id !== BUTTON_ID && /^(Add file|Uploading…|Uploading\.\.\.|Finalizing…|Finalizing\.\.\.)$/.test(button.textContent?.trim() || ""));

      if (header && container && nativeInput && nativeAddButton) {
        return { heading, header, container, nativeInput, nativeAddButton };
      }
    }

    return null;
  }

  function readNativeRows() {
    const panel = findNativePanel();
    if (!panel) return [];

    return [...panel.container.querySelectorAll("table tbody tr")].flatMap((tr) => {
      const cells = tr.querySelectorAll("td");
      const removeButton = [...tr.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "remove");
      const downloadButton = [...tr.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "download");
      const filename = cells[0]?.textContent?.trim() || "";
      const sizeText = cells[1]?.textContent?.trim() || "";
      const hashElement = cells[2]?.querySelector("[title]");
      const sha256 = hashElement?.getAttribute("title") || cells[2]?.textContent?.trim() || "";

      if (!filename || !removeButton) return [];
      return [{ filename, sizeText, sha256, tr, removeButton, downloadButton }];
    });
  }

  function ensureBulkButton() {
    const panel = findNativePanel();
    if (!panel || document.getElementById(BUTTON_ID)) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Bulk files";
    button.title = "Bulk upload, download, or delete staged files";
    button.style.cssText = [
      "font-size:12px",
      "padding:4px 10px",
      "border:1px solid var(--accent, #346ee8)",
      "color:var(--accent, #346ee8)",
      "background:var(--surface, transparent)",
      "border-radius:4px",
      "cursor:pointer",
      "margin-left:auto",
      "margin-right:6px"
    ].join(";");
    button.addEventListener("click", openDialog);
    panel.nativeAddButton.insertAdjacentElement("beforebegin", button);
  }

  function openDialog() {
    refreshRows();
    ui.backdrop.classList.add("open");
    host.style.pointerEvents = "auto";
    ui.close.focus();
  }

  function closeDialog() {
    if (busy) return;
    ui.backdrop.classList.remove("open");
    host.style.pointerEvents = "none";
  }

  function switchTab(name) {
    if (busy || !["upload", "download", "delete"].includes(name)) return;
    currentTab = name;
    for (const tab of ui.tabs) tab.classList.toggle("active", tab.dataset.tab === name);
    for (const panel of ui.panels) panel.classList.toggle("active", panel.dataset.panel === name);
    clearStatus();
    if (name === "download" || name === "delete") refreshRows();
  }

  function setBusy(value) {
    busy = value;
    ui.close.disabled = value;
    ui.fileInput.disabled = value;
    ui.chooseButton.disabled = value;
    ui.dropZone.classList.toggle("busy", value);
    ui.dropZone.setAttribute("aria-disabled", String(value));
    ui.uploadAck.disabled = value;
    ui.tabs.forEach((tab) => { tab.disabled = value; });
    ui.selectAll.disabled = value;
    ui.selectNone.disabled = value;
    ui.refresh.disabled = value;
    ui.downloadSelectAll.disabled = value;
    ui.downloadSelectNone.disabled = value;
    ui.downloadRefresh.disabled = value;
    ui.stopButtons.forEach((button) => {
      button.disabled = !value || button.dataset.stopMode !== currentTab;
      if (!value) {
        button.textContent = button.classList.contains("stop-delete")
          ? "Stop deletion"
          : "Stop after current file";
      }
    });
    updateUploadButton();
    updateDownloadButton();
    updateDeleteButton();
  }

  function setStatus(message, kind = "", announce = true) {
    ui.status.setAttribute("aria-live", announce ? "polite" : "off");
    ui.status.textContent = message;
    ui.status.className = `status show${kind ? ` ${kind}` : ""}`;
  }

  function clearStatus() {
    ui.status.textContent = "";
    ui.status.className = "status";
  }

  function closeConfirmation(value) {
    const pending = pendingConfirmation;
    if (!pending) return;
    pendingConfirmation = null;
    ui.confirmBackdrop.classList.remove("open");
    ui.confirmApply.textContent = "Confirm";
    pending.resolve(value);
  }

  function requestBatchConfirmation({ title, copy, names, confirmLabel }) {
    if (pendingConfirmation) return Promise.resolve(false);
    ui.confirmTitle.textContent = title;
    ui.confirmCopy.textContent = copy;
    ui.confirmList.replaceChildren(...names.map((name) => {
      const item = document.createElement("li");
      item.textContent = name;
      return item;
    }));
    ui.confirmApply.textContent = confirmLabel;
    ui.confirmBackdrop.classList.add("open");
    ui.confirmCancel.focus({ preventScroll: true });
    return new Promise((resolve) => {
      pendingConfirmation = { resolve };
    });
  }

  function currentExistingNames() {
    return new Set(readNativeRows().map((row) => row.filename));
  }

  function classifyUploads(files = selectedUploads) {
    const existingNames = currentExistingNames();
    const queuedNames = new Set();
    const uploadable = [];
    const skipped = [];
    const entries = [];

    for (const file of files) {
      let reason = "";
      if (existingNames.has(file.name)) reason = "already staged - skipped";
      else if (queuedNames.has(file.name)) reason = "repeated selection - skipped";

      if (reason) skipped.push({ file, reason });
      else {
        uploadable.push(file);
        queuedNames.add(file.name);
      }
      entries.push({ file, reason });
    }

    return { entries, uploadable, skipped };
  }

  function renderUploadFiles() {
    if (!selectedUploads.length) {
      ui.fileList.innerHTML = "";
      ui.fileList.classList.remove("has-files");
      updateUploadButton();
      return;
    }

    const { entries } = classifyUploads();
    ui.fileList.classList.add("has-files");
    ui.fileList.innerHTML = entries.map(({ file, reason }) => `
      <div class="row">
        <div class="name ${reason ? "skip" : ""}">${escapeHtml(file.name)}</div>
        <div class="meta">${escapeHtml(formatBytes(file.size))}${reason ? ` - ${escapeHtml(reason)}` : ""}</div>
      </div>
    `).join("");
    updateUploadButton();
  }

  function updateUploadButton() {
    const { uploadable, skipped } = classifyUploads();
    const count = uploadable.length;
    if (count) {
      ui.uploadButton.textContent = `Upload ${count} new file${count === 1 ? "" : "s"}${skipped.length ? ` (${skipped.length} duplicate${skipped.length === 1 ? "" : "s"} skipped)` : ""}`;
    } else if (skipped.length) {
      ui.uploadButton.textContent = "No new files to upload";
    } else {
      ui.uploadButton.textContent = "Upload selected files";
    }
    ui.uploadButton.disabled = busy || !count || !ui.uploadAck.checked;
  }

  function refreshRows() {
    stagedRows = readNativeRows();
    const keyCounts = new Map();
    for (const row of stagedRows) keyCounts.set(rowKey(row), (keyCounts.get(rowKey(row)) || 0) + 1);
    ambiguousRowKeys = new Set([...keyCounts].filter(([, count]) => count > 1).map(([key]) => key));
    const validKeys = new Set(stagedRows.map(rowKey));
    selectedDeleteKeys = new Set([...selectedDeleteKeys].filter((key) => validKeys.has(key) && !ambiguousRowKeys.has(key)));
    selectedDownloadKeys = new Set([...selectedDownloadKeys].filter((key) => validKeys.has(key) && !ambiguousRowKeys.has(key)));
    renderDownloadRows();
    renderDeleteRows();
    renderUploadFiles();
  }

  function renderDownloadRows() {
    const downloadableRows = stagedRows;
    if (!downloadableRows.length) {
      ui.downloadList.innerHTML = '<div class="empty">No downloadable staged files are visible on this page.</div>';
      updateDownloadButton();
      return;
    }

    ui.downloadList.innerHTML = downloadableRows.map((row) => {
      const key = rowKey(row);
      const ambiguous = ambiguousRowKeys.has(key);
      return `
        <label class="row select-row">
          <input type="checkbox" data-download-key="${escapeHtml(key)}" ${selectedDownloadKeys.has(key) ? "checked" : ""} ${ambiguous ? "disabled" : ""}>
          <span class="name">${escapeHtml(row.filename)}</span>
          <span class="meta ${ambiguous ? "skip" : ""}">${ambiguous ? "duplicate row - use page control" : `${escapeHtml(row.sizeText)} · ${escapeHtml(row.sha256.slice(0, 8))}`}</span>
        </label>
      `;
    }).join("");

    for (const checkbox of ui.downloadList.querySelectorAll("[data-download-key]")) {
      checkbox.addEventListener("change", () => {
        const key = checkbox.dataset.downloadKey;
        if (checkbox.checked) selectedDownloadKeys.add(key);
        else selectedDownloadKeys.delete(key);
        updateDownloadButton();
      });
    }
    updateDownloadButton();
  }

  function updateDownloadButton() {
    const count = selectedDownloadKeys.size;
    ui.downloadButton.textContent = count ? `Download ${count} selected file${count === 1 ? "" : "s"} as ZIP` : "Download selected files as ZIP";
    ui.downloadButton.disabled = busy || !count;
  }

  function renderDeleteRows() {
    if (!stagedRows.length) {
      ui.currentList.innerHTML = '<div class="empty">No staged files are visible on this page.</div>';
      updateDeleteButton();
      return;
    }

    ui.currentList.innerHTML = stagedRows.map((row) => {
      const key = rowKey(row);
      const ambiguous = ambiguousRowKeys.has(key);
      return `
        <label class="row select-row">
          <input type="checkbox" data-delete-key="${escapeHtml(key)}" ${selectedDeleteKeys.has(key) ? "checked" : ""} ${ambiguous ? "disabled" : ""}>
          <span class="name">${escapeHtml(row.filename)}</span>
          <span class="meta ${ambiguous ? "skip" : ""}">${ambiguous ? "duplicate row - use page control" : `${escapeHtml(row.sizeText)} · ${escapeHtml(row.sha256.slice(0, 8))}`}</span>
        </label>
      `;
    }).join("");

    for (const checkbox of ui.currentList.querySelectorAll("[data-delete-key]")) {
      checkbox.addEventListener("change", () => {
        const key = checkbox.dataset.deleteKey;
        if (checkbox.checked) selectedDeleteKeys.add(key);
        else selectedDeleteKeys.delete(key);
        updateDeleteButton();
      });
    }
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const count = selectedDeleteKeys.size;
    ui.deleteButton.textContent = count ? `Delete ${count} selected file${count === 1 ? "" : "s"}` : "Delete selected files";
    ui.deleteButton.disabled = busy || !count;
  }

  function nativeErrorText(panel) {
    const candidates = [...panel.container.querySelectorAll("div")]
      .filter((element) => {
        const color = element.style?.color || "";
        return color.includes("--danger") && element.children.length === 0;
      })
      .map((element) => element.textContent?.trim())
      .filter(Boolean);
    return candidates[0] || "";
  }

  function nativeProgressText(panel, filename) {
    const text = panel.container.innerText || "";
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const percent = text.match(new RegExp(`${escaped}\\s+[—-]\\s+\\d+%`));
    if (percent) return percent[0];
    if (/Hashing on host & posting Linear comment/.test(text)) return "Finalizing and posting the Linear comment";
    return "Waiting for the Teal page";
  }

  async function waitForNativeReady() {
    const startedAt = Date.now();
    let readySince = 0;
    while (Date.now() - startedAt < UPLOAD_START_TIMEOUT_MS) {
      const panel = findNativePanel();
      const inputIsReset = panel && !panel.nativeInput.value && (!panel.nativeInput.files || panel.nativeInput.files.length === 0);
      const isReady = panel && !panel.nativeAddButton.disabled && panel.nativeAddButton.textContent?.trim() === "Add file" && inputIsReset;
      if (isReady) {
        readySince ||= Date.now();
        if (Date.now() - readySince >= UPLOAD_READY_STABLE_MS) return panel;
      } else {
        readySince = 0;
      }
      await sleep(150);
    }
    throw new Error("The page's Add file control and file input did not become stably ready.");
  }

  async function uploadOneFile(file, queueIndex, totalCount) {
    const panel = await waitForNativeReady();
    const beforeKeys = new Set(readNativeRows().map(rowKey));
    const transfer = new DataTransfer();
    transfer.items.add(file);
    panel.nativeInput.files = transfer.files;
    panel.nativeInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const startedAt = Date.now();
    let sawBusy = false;
    let readyWithoutRowAt = 0;
    let addedRowSeenAt = 0;
    let settledSince = 0;
    let settledSignature = "";

    while (Date.now() - startedAt < UPLOAD_TIMEOUT_MS) {
      const currentPanel = findNativePanel();
      if (!currentPanel) throw new Error("The staged-files panel disappeared during upload.");

      const currentRows = readNativeRows();
      const addedRow = currentRows.find((row) => row.filename === file.name && !beforeKeys.has(rowKey(row)));
      const addText = currentPanel.nativeAddButton.textContent?.trim() || "";
      const isBusy = currentPanel.nativeAddButton.disabled || addText !== "Add file";
      sawBusy ||= isBusy;

      const error = nativeErrorText(currentPanel);
      if (sawBusy && !isBusy && error) throw new Error(error);

      if (addedRow) {
        addedRowSeenAt ||= Date.now();
        const inputIsReset = !currentPanel.nativeInput.value && (!currentPanel.nativeInput.files || currentPanel.nativeInput.files.length === 0);
        const signature = currentRows.map(rowKey).join("\u001f");
        const isSettled = !isBusy && inputIsReset && !error;

        setStatus(`Uploading ${queueIndex + 1} of ${totalCount}: ${file.name}\nConfirming that Teal is ready for the next file`);

        if (isSettled) {
          if (signature !== settledSignature) {
            settledSignature = signature;
            settledSince = Date.now();
          } else {
            settledSince ||= Date.now();
          }
          if (Date.now() - settledSince >= UPLOAD_SETTLE_STABLE_MS) return addedRow;
        } else {
          settledSince = 0;
          settledSignature = "";
        }

        if (Date.now() - addedRowSeenAt > UPLOAD_SETTLE_TIMEOUT_MS) {
          throw new Error("Teal added the file, but its upload controls did not become stably ready for the next file.");
        }
      } else {
        setStatus(`Uploading ${queueIndex + 1} of ${totalCount}: ${file.name}\n${nativeProgressText(currentPanel, file.name)}`);
      }

      if (!addedRow && sawBusy && !isBusy) {
        readyWithoutRowAt ||= Date.now();
        if (Date.now() - readyWithoutRowAt > 5_000) {
          throw new Error("The page finished the upload but did not add the file to the staged-file list.");
        }
      } else {
        readyWithoutRowAt = 0;
      }

      if (!sawBusy && Date.now() - startedAt > UPLOAD_START_TIMEOUT_MS) {
        throw new Error("The page did not start the upload.");
      }

      await sleep(250);
    }

    throw new Error("The upload timed out before the page confirmed the staged file.");
  }

  async function startUpload(options = {}) {
    if (busy) return;
    renderUploadFiles();

    const sourceFiles = Array.isArray(options.files) ? options.files : selectedUploads;
    const { uploadable, skipped } = classifyUploads(sourceFiles);
    if (!sourceFiles.length || (!ui.uploadAck.checked && !options.fromBridge)) return;
    if (!uploadable.length) {
      setStatus(`Skipped ${skipped.length} duplicate file${skipped.length === 1 ? "" : "s"}. No new filenames need upload.`, "success");
      return { operation: "upload", succeeded: [], skipped: skipped.map(({ file, reason }) => ({ name: file.name, reason })), failed: [], remaining: [] };
    }

    // A CLI apply is already gated by its one-use plan token and exact
    // inventory recheck. Keep the visible confirmation for human UI actions.
    const confirmed = options.fromBridge ? true : await requestBatchConfirmation({
      title: `Upload ${uploadable.length} new file${uploadable.length === 1 ? "" : "s"}?`,
      copy: `The Teal platform will post one Linear comment for each successfully finalized file.${skipped.length ? ` ${skipped.length} duplicate selection${skipped.length === 1 ? " is" : "s are"} skipped.` : ""}`,
      names: uploadable.map((file) => `${file.name} (${formatBytes(file.size)})`),
      confirmLabel: "Confirm upload"
    });
    if (!confirmed) return { operation: "upload", cancelled: true, succeeded: [], skipped: [], failed: [], remaining: uploadable.map((file) => file.name) };

    setBusy(true);
    activeOperation = "upload";
    stopAfterCurrent = false;
    const uploadQueue = [...uploadable];
    let completed = 0;
    let nextIndex = 0;
    let runtimeSkipped = 0;
    const succeededNames = [];
    const runtimeSkippedEntries = [];

    try {
      for (; nextIndex < uploadQueue.length; nextIndex += 1) {
        const file = uploadQueue[nextIndex];
        if (currentExistingNames().has(file.name)) {
          runtimeSkipped += 1;
          runtimeSkippedEntries.push({ name: file.name, reason: "became staged before upload - skipped" });
          selectedUploads = uploadQueue.slice(nextIndex + 1);
          renderUploadFiles();
          continue;
        }

        await uploadOneFile(file, nextIndex, uploadQueue.length);
        completed += 1;
        succeededNames.push(file.name);
        selectedUploads = uploadQueue.slice(nextIndex + 1);
        refreshRows();
        if (stopAfterCurrent) {
          nextIndex += 1;
          break;
        }
      }

      const totalSkipped = skipped.length + runtimeSkipped;
      if (stopAfterCurrent && nextIndex < uploadQueue.length) {
        setStatus(`Stopped after ${completed} successful file${completed === 1 ? "" : "s"}. ${uploadQueue.length - nextIndex} file${uploadQueue.length - nextIndex === 1 ? "" : "s"} remain selected.${totalSkipped ? ` Skipped ${totalSkipped} duplicate${totalSkipped === 1 ? "" : "s"}.` : ""}`, "success");
      } else {
        setStatus(`Uploaded and finalized ${completed} file${completed === 1 ? "" : "s"}.${totalSkipped ? ` Skipped ${totalSkipped} duplicate${totalSkipped === 1 ? "" : "s"}.` : ""}`, "success");
        ui.fileInput.value = "";
        selectedUploads = [];
        ui.uploadAck.checked = false;
        renderUploadFiles();
      }
      return {
        operation: "upload",
        succeeded: succeededNames,
        skipped: [...skipped.map(({ file, reason }) => ({ name: file.name, reason })), ...runtimeSkippedEntries],
        failed: [],
        remaining: selectedUploads.map((file) => file.name)
      };
    } catch (error) {
      selectedUploads = uploadQueue.slice(nextIndex);
      renderUploadFiles();
      const remaining = selectedUploads.length;
      setStatus(`Stopped after ${completed} successful file${completed === 1 ? "" : "s"}. ${remaining} file${remaining === 1 ? "" : "s"} remain selected for a manual retry.\n${error instanceof Error ? error.message : String(error)}`, "error");
      return {
        operation: "upload",
        succeeded: succeededNames,
        skipped: [...skipped.map(({ file, reason }) => ({ name: file.name, reason })), ...runtimeSkippedEntries],
        failed: [{ name: uploadQueue[nextIndex]?.name || "", error: error instanceof Error ? error.message : String(error) }],
        remaining: selectedUploads.map((file) => file.name)
      };
    } finally {
      setBusy(false);
      activeOperation = "";
      refreshRows();
    }
  }

  function findCurrentRow(expected) {
    return readNativeRows().find((row) => rowKey(row) === rowKey(expected));
  }

  function nativeListIsLoading(panel) {
    const text = panel?.container?.innerText || "";
    return /(?:^|\n)Loading(?:…|\.\.\.)(?:\n|$)/.test(text);
  }

  async function fetchDownloadApiRows() {
    const response = await fetch(`/api/staged-files?issue_identifier=${encodeURIComponent(issueIdentifier)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `The staged-file API returned ${response.status}.`);
    }
    if (!Array.isArray(payload.rows)) throw new Error("The staged-file API did not return a file list.");
    return payload.rows;
  }

  function stagedByteSize(apiRow) {
    const hasByteSize = apiRow && Object.prototype.hasOwnProperty.call(apiRow, "byte_size");
    const size = hasByteSize ? apiRow.byte_size : apiRow?.size;
    return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
  }

  async function fetchSignedDownloadUrl(stagedId) {
    if ((typeof stagedId !== "string" && typeof stagedId !== "number") || String(stagedId).length > 200) {
      throw new Error("The staged-file API returned an invalid file ID.");
    }
    const response = await fetch(`/api/staged-files/${encodeURIComponent(String(stagedId))}/download-url`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `The download-link API returned ${response.status}.`);
    }
    if (typeof payload.download_url !== "string") throw new Error("The server returned no download URL.");
    let parsed;
    try {
      parsed = new URL(payload.download_url);
    } catch {
      throw new Error("The server returned an invalid download URL.");
    }
    const localMockUrl = window.location.hostname === "127.0.0.1" && parsed.origin === window.location.origin;
    if ((!localMockUrl && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error("The server returned an unsafe download URL.");
    }
    return parsed.href;
  }

  async function readArchiveSource(response, expectedSize, filename, currentTotalBytes) {
    const headerSizeText = response.headers.get("content-length");
    if (headerSizeText && Number(headerSizeText) !== expectedSize) {
      throw new Error(`The server reported a changed size for ${filename}. Refresh the list and try again.`);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error(`The browser could not stream ${filename} into the ZIP.`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
        received += chunk.byteLength;
        if (received > expectedSize || received > MAX_ARCHIVE_FILE_BYTES || currentTotalBytes + received > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`The source data for ${filename} exceeded the safe ZIP size limit.`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (received !== expectedSize) {
      throw new Error(`The downloaded size changed for ${filename}. Refresh the list and try again.`);
    }
    return new Blob(chunks, { type: "application/octet-stream" });
  }

  function makeArchiveFilename() {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    return `${issueIdentifier}-staged-files-${date}.zip`;
  }

  function indeterminateDownloadError(message, downloadId) {
    const error = new Error(message);
    error.indeterminate = true;
    if (Number.isInteger(downloadId)) error.downloadId = downloadId;
    return error;
  }

  function revokeRetainedBlobUrl(blobUrl) {
    const timer = retainedIndeterminateBlobUrls.get(blobUrl);
    if (timer) window.clearTimeout(timer);
    retainedIndeterminateBlobUrls.delete(blobUrl);
    URL.revokeObjectURL(blobUrl);
  }

  function retainIndeterminateBlobUrl(blobUrl) {
    if (!blobUrl || retainedIndeterminateBlobUrls.has(blobUrl)) return;
    const timer = window.setTimeout(() => revokeRetainedBlobUrl(blobUrl), INDETERMINATE_BLOB_RETENTION_MS);
    retainedIndeterminateBlobUrls.set(blobUrl, timer);
  }

  function revokeAllRetainedBlobUrls() {
    for (const blobUrl of [...retainedIndeterminateBlobUrls.keys()]) revokeRetainedBlobUrl(blobUrl);
  }

  function requestEdgeSaveAs({ batchId, entries, archiveFilename, blobUrl }) {
    const requestId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const pending = pendingZipRequests.get(requestId);
        pendingZipRequests.delete(requestId);
        reject(indeterminateDownloadError(
          pending?.started
            ? `The browser started the Save As request for ${archiveFilename}, but did not report its final state.`
            : `The Save As request for ${archiveFilename} timed out without a confirmed final state.`,
          pending?.downloadId
        ));
      }, DOWNLOAD_SAVE_AS_TIMEOUT_MS);
      pendingZipRequests.set(requestId, { resolve, reject, timer, started: false, downloadId: null });
      chrome.runtime.sendMessage({
        type: SAVE_ZIP_MESSAGE,
        requestId,
        batchId,
        sequence: 0,
        issueIdentifier,
        entries,
        archiveFilename,
        blobUrl
      }).then((response) => {
        const pending = pendingZipRequests.get(requestId);
        if (!pending) return;
        if (response?.ok === true && response.started === true) {
          pending.started = true;
          pending.downloadId = Number.isInteger(response.downloadId) ? response.downloadId : null;
          return;
        }
        window.clearTimeout(pending.timer);
        pendingZipRequests.delete(requestId);
        if (response?.indeterminate === true || response?.started === true) {
          pending.reject(indeterminateDownloadError(
            response?.error || `The browser may have started the Save As request for ${archiveFilename}, but its state was not confirmed.`,
            response?.downloadId
          ));
        } else {
          pending.reject(new Error(response?.error || `Edge did not start the Save As dialog for ${archiveFilename}.`));
        }
      }).catch((error) => {
        const pending = pendingZipRequests.get(requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingZipRequests.delete(requestId);
        pending.reject(indeterminateDownloadError(
          `The Save As request lost contact with the extension after dispatch. ${error instanceof Error ? error.message : String(error)}`,
          pending.downloadId
        ));
      });
    });
  }

  async function waitForDownloadTarget(expected) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < DOWNLOAD_LIST_READY_TIMEOUT_MS) {
      const panel = findNativePanel();
      if (!panel || nativeListIsLoading(panel)) {
        await sleep(150);
        continue;
      }

      const current = findCurrentRow(expected);
      if (current) return { current, panel };
      throw new Error(`The page changed before download: ${expected.filename}`);
    }

    throw new Error(`The staged-file list did not become ready before downloading ${expected.filename}.`);
  }

  async function startDownload(options = {}) {
    const plannedRows = Array.isArray(options.rows) ? options.rows : null;
    const requestedNames = plannedRows ? plannedRows.map((row) => row.filename) : [];
    if (busy) {
      return { operation: "download", succeeded: [], skipped: [], failed: [{ name: "", error: "A bulk operation is already running." }], remaining: requestedNames };
    }
    if (!plannedRows && !selectedDownloadKeys.size) return;
    refreshRows();

    const selected = plannedRows
      ? plannedRows.filter((row) => stagedRows.some((current) => rowKey(current) === rowKey(row)))
      : stagedRows.filter((row) => selectedDownloadKeys.has(rowKey(row)));
    const expectedCount = plannedRows ? plannedRows.length : selectedDownloadKeys.size;
    const selectedNames = selected.map((row) => row.filename);
    if (selected.length !== expectedCount) {
      const error = "The staged-file list changed.";
      setStatus("The staged-file list changed. Review the refreshed selection before download.", "error");
      return { operation: "download", succeeded: [], skipped: [], failed: [{ name: "", error }], remaining: plannedRows ? requestedNames : selectedNames };
    }

    setBusy(true);
    activeOperation = "download";
    stopAfterCurrent = false;
    let blobUrl = "";
    let archiveFilename = "";
    let failureTarget = selectedNames[0] || "";
    const batchId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

    try {
      const apiRows = await fetchDownloadApiRows();
      const queue = selected.map((row) => {
        failureTarget = row.filename;
        const matches = apiRows.filter((apiRow) =>
          typeof apiRow === "object" && apiRow !== null &&
          typeof apiRow.id !== "undefined" &&
          apiRow.filename === row.filename &&
          String(apiRow.sha256 || "").toLowerCase() === String(row.sha256 || "").toLowerCase()
        );
        if (matches.length !== 1) {
          throw new Error(`The staged-file API could not identify exactly one copy of ${row.filename}.`);
        }
        const apiRow = matches[0];
        const byteSize = stagedByteSize(apiRow);
        if (byteSize === null) {
          throw new Error(`Teal did not report a safe byte size for ${row.filename}.`);
        }
        if (byteSize > MAX_ARCHIVE_FILE_BYTES) {
          throw new Error(`${row.filename} is too large for one browser-built ZIP.`);
        }
        return { row, apiRow, byteSize };
      });
      if (queue.length > 500) throw new Error("Select 500 or fewer files for one ZIP.");
      const advertisedBytes = queue.reduce((total, { byteSize }) => total + byteSize, 0);
      if (!Number.isSafeInteger(advertisedBytes) || advertisedBytes > MAX_ARCHIVE_BYTES) {
        throw new Error("The selected files are too large for one browser-built ZIP. Select fewer files.");
      }

      const archiveNames = new Set();
      for (const { row } of queue) {
        const nameKey = row.filename.toLocaleLowerCase("en-US");
        if (archiveNames.has(nameKey)) {
          throw new Error(`Two selected files use the name ${row.filename}. Select only one of them for a ZIP.`);
        }
        archiveNames.add(nameKey);
      }

      if (!globalThis.TealEvalZip?.build || !globalThis.TealEvalZip?.sha256) {
        throw new Error("The ZIP builder did not load. Reload the extension and refresh this page.");
      }

      const archiveFiles = [];
      let totalBytes = 0;
      for (const [index, { row, apiRow, byteSize }] of queue.entries()) {
        failureTarget = row.filename;
        await waitForDownloadTarget(row);
        setStatus(`Reading ${index + 1} of ${queue.length} for the ZIP: ${row.filename}`);
        const signedUrl = await fetchSignedDownloadUrl(apiRow.id);
        const fileResponse = await fetch(signedUrl, {
          method: "GET",
          credentials: "omit",
          cache: "no-store"
        });
        if (!fileResponse.ok) {
          throw new Error(`Teal returned ${fileResponse.status} while reading ${row.filename} for the ZIP.`);
        }
        const blob = await readArchiveSource(fileResponse, byteSize, row.filename, totalBytes);
        setStatus(`Verifying ${index + 1} of ${queue.length} for the ZIP: ${row.filename}`);
        const downloadedSha256 = await globalThis.TealEvalZip.sha256(blob);
        if (downloadedSha256 !== String(row.sha256 || "").toLowerCase()) {
          throw new Error(`The SHA-256 value changed for ${row.filename}. No ZIP was saved.`);
        }
        totalBytes += blob.size;
        archiveFiles.push({ name: row.filename, blob, lastModified: Date.now() });
        if (stopAfterCurrent) {
          setStatus(`Stopped while preparing the ZIP after ${index + 1} of ${queue.length} files. No ZIP was saved, and all files remain selected.`, "success");
          return { operation: "download", cancelled: true, succeeded: [], skipped: [], failed: [], remaining: selectedNames };
        }
      }

      setStatus(`Building one ZIP with ${queue.length} files...`);
      const archiveBlob = await globalThis.TealEvalZip.build(archiveFiles, {
        onProgress: ({ fileIndex, fileCount, name }) => {
          setStatus(`Building ZIP entry ${fileIndex + 1} of ${fileCount}: ${name}`);
        }
      });
      archiveFilename = makeArchiveFilename();
      failureTarget = archiveFilename;
      blobUrl = URL.createObjectURL(archiveBlob);
      setStatus(`Waiting for one Edge Save As dialog for ${archiveFilename}`);
      const downloadId = await requestEdgeSaveAs({
        batchId,
        entries: queue.map(({ row, apiRow }) => ({
          stagedId: String(apiRow.id),
          filename: row.filename,
          sha256: row.sha256 || ""
        })),
        archiveFilename,
        blobUrl
      });
      for (const { row } of queue) selectedDownloadKeys.delete(rowKey(row));
      renderDownloadRows();
      setStatus(`Saved one ZIP with ${queue.length} file${queue.length === 1 ? "" : "s"}.`, "success");
      return {
        operation: "download",
        succeeded: selectedNames,
        skipped: [],
        failed: [],
        remaining: [],
        archiveFilename,
        downloadId
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (error?.indeterminate === true) {
        retainIndeterminateBlobUrl(blobUrl);
        blobUrl = "";
        setStatus(`The browser may have started saving ${archiveFilename || "the ZIP"}, but its final state was not confirmed. Check browser Downloads before you retry. All selected files remain selected.`, "error");
        return {
          ok: false,
          operation: "download",
          indeterminate: true,
          error: errorMessage,
          succeeded: [],
          skipped: [],
          failed: [],
          remaining: selectedNames,
          ...(archiveFilename ? { archiveFilename } : {}),
          ...(Number.isInteger(error?.downloadId) ? { downloadId: error.downloadId } : {})
        };
      }
      setStatus(`The ZIP was not saved. All selected files remain selected.\n${errorMessage}`, "error");
      return {
        operation: "download",
        succeeded: [],
        skipped: [],
        failed: [{ name: failureTarget, error: errorMessage }],
        remaining: selectedNames
      };
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setBusy(false);
      activeOperation = "";
      refreshRows();
    }
  }

  async function waitForDeleteTarget(expected) {
    const startedAt = Date.now();
    let stableMissingSince = 0;

    while (Date.now() - startedAt < DELETE_LIST_READY_TIMEOUT_MS) {
      const panel = findNativePanel();
      if (!panel || nativeListIsLoading(panel)) {
        stableMissingSince = 0;
        await sleep(150);
        continue;
      }

      const current = findCurrentRow(expected);
      if (current) return { current, panel };

      stableMissingSince ||= Date.now();
      if (Date.now() - stableMissingSince >= DELETE_LIST_STABLE_MS) {
        throw new Error(`The page changed before deletion: ${expected.filename}`);
      }
      await sleep(100);
    }

    throw new Error(`The staged-file list did not become ready before deleting ${expected.filename}.`);
  }

  async function waitForDeletionToSettle(expected, startingError) {
    const startedAt = Date.now();
    let stableAbsentSince = 0;

    while (Date.now() - startedAt < DELETE_TIMEOUT_MS) {
      const panel = findNativePanel();
      if (!panel) {
        stableAbsentSince = 0;
        await sleep(150);
        continue;
      }

      const error = nativeErrorText(panel);
      if (error && error !== startingError) throw new Error(error);

      const current = findCurrentRow(expected);
      const loading = nativeListIsLoading(panel);
      if (current || loading) {
        stableAbsentSince = 0;
      } else {
        stableAbsentSince ||= Date.now();
        if (Date.now() - stableAbsentSince >= DELETE_LIST_STABLE_MS) return;
      }

      await sleep(100);
    }

    throw new Error(`The page did not confirm deletion of ${expected.filename}.`);
  }

  async function deleteOneRow(expected, completedCount, totalCount) {
    const { current, panel: startingPanel } = await waitForDeleteTarget(expected);
    if (deleteStopRequested) return false;
    const startingError = nativeErrorText(startingPanel);

    setStatus(`Deleting ${completedCount + 1} of ${totalCount}: ${expected.filename}`);
    if (deleteStopRequested) return false;
    const result = await chrome.runtime.sendMessage({
      type: NATIVE_DELETE_MESSAGE,
      issueIdentifier,
      filename: expected.filename,
      sha256: expected.sha256 || ""
    });
    if (!result || result.ok !== true || Object.keys(result).length !== 1) {
      throw new Error(result?.error || `The page did not confirm one exact native deletion for ${expected.filename}.`);
    }

    await waitForDeletionToSettle(expected, startingError);
    return true;
  }

  async function startDelete(options = {}) {
    if (busy || (!selectedDeleteKeys.size && !Array.isArray(options.rows))) return;
    refreshRows();

    const selected = Array.isArray(options.rows)
      ? options.rows.filter((row) => stagedRows.some((current) => rowKey(current) === rowKey(row)))
      : stagedRows.filter((row) => selectedDeleteKeys.has(rowKey(row)));
    const expectedCount = Array.isArray(options.rows) ? options.rows.length : selectedDeleteKeys.size;
    if (selected.length !== expectedCount) {
      setStatus("The staged-file list changed. Review the refreshed selection before deletion.", "error");
      return { operation: "delete", succeeded: [], skipped: [], failed: [{ error: "The staged-file list changed." }], remaining: [] };
    }

    // A CLI apply is already gated by its one-use plan token and exact
    // inventory recheck. Keep the visible confirmation for human UI actions.
    const confirmed = options.fromBridge ? true : await requestBatchConfirmation({
      title: `Permanently delete ${selected.length} staged file${selected.length === 1 ? "" : "s"}?`,
      copy: "Completed deletions cannot be undone. Active runs may still reference these files. After confirmation, you have five seconds to stop before the first deletion starts.",
      names: selected.map((row) => `${row.filename} · ${String(row.sha256 || "").slice(0, 8)}`),
      confirmLabel: "Confirm deletion"
    });
    if (!confirmed) return { operation: "delete", cancelled: true, succeeded: [], skipped: [], failed: [], remaining: selected.map((row) => row.filename) };

    deleteStopRequested = false;
    setBusy(true);
    activeOperation = "delete";
    ui.stopDelete.focus({ preventScroll: true });
    let completed = 0;

    try {
      for (let remaining = DELETE_GRACE_PERIOD_SECONDS; remaining > 0; remaining -= 1) {
        setStatus(
          `Deleted 0 of ${selected.length}. Remaining selected: ${selected.length}. ` +
          `Deletion starts in ${remaining} second${remaining === 1 ? "" : "s"}. Click Stop deletion to cancel.`,
          "",
          remaining === DELETE_GRACE_PERIOD_SECONDS
        );
        await sleep(1000);
        if (deleteStopRequested) break;
      }

      for (const row of selected) {
        if (deleteStopRequested) break;
        const started = await deleteOneRow(row, completed, selected.length);
        if (!started) break;
        completed += 1;
        selectedDeleteKeys.delete(rowKey(row));
        refreshRows();
        if (deleteStopRequested) break;
      }

      const remaining = selected.length - completed;
      if (deleteStopRequested && remaining > 0) {
        if (completed === 0) {
          setStatus(
            `Deletion cancelled. Deleted 0 of ${selected.length}. Remaining selected: ${remaining}.`,
            "success"
          );
        } else {
          setStatus(
            `Stopped. Deleted ${completed} of ${selected.length}. Remaining selected: ${remaining}. ` +
            `No later file was started.`,
            "success"
          );
        }
      } else {
        setStatus(`Deleted ${completed} of ${selected.length}. Remaining selected: 0.`, "success");
      }
      return {
        operation: "delete",
        succeeded: selected.slice(0, completed).map((row) => row.filename),
        skipped: [],
        failed: [],
        remaining: selected.slice(completed).map((row) => row.filename)
      };
    } catch (error) {
      setStatus(
        `Stopped. Deleted ${completed} of ${selected.length}. Remaining selected: ${selected.length - completed}.\n` +
        `${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return {
        operation: "delete",
        succeeded: selected.slice(0, completed).map((row) => row.filename),
        skipped: [],
        failed: [{ name: selected[completed]?.filename || "", error: error instanceof Error ? error.message : String(error) }],
        remaining: selected.slice(completed).map((row) => row.filename)
      };
    } finally {
      setBusy(false);
      activeOperation = "";
      refreshRows();
    }
  }

  function validBridgeName(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\\/\u0000-\u001f]/.test(value);
  }

  function parseBridgeNames(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500 || !value.every(validBridgeName)) {
      throw new Error("The command names were invalid.");
    }
    return [...value];
  }

  function publicInventory() {
    refreshRows();
    return stagedRows
      .map((row) => ({ filename: row.filename, sha256: row.sha256 || "", sizeText: row.sizeText || "" }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"));
  }

  function createBridgeAuthorizationId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function isPlainBridgeObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function hasExactBridgeKeys(value, expected) {
    if (!isPlainBridgeObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function bridgeCommandKeys(command) {
    if (["capabilities", "status", "list", "prepare-upload", "cancel-upload", "stop"].includes(command)) return ["command"];
    if (["plan-upload", "plan-download", "plan-delete"].includes(command)) return ["command", "names"];
    if (["apply-upload", "apply-download", "apply-delete"].includes(command)) return ["authorizationId", "command", "names"];
    return [];
  }

  function clearBridgeUploadSelection({ clearFiles = true } = {}) {
    if (bridgeUploadSelectionTimer) window.clearTimeout(bridgeUploadSelectionTimer);
    bridgeUploadSelectionTimer = 0;
    bridgeUploadSelectionActive = false;
    ui.bridgeUploadInput.value = "";
    if (clearFiles) {
      selectedUploads = [];
      renderUploadFiles();
    }
  }

  function armBridgeUploadSelectionTimer() {
    if (bridgeUploadSelectionTimer) window.clearTimeout(bridgeUploadSelectionTimer);
    bridgeUploadSelectionTimer = window.setTimeout(() => clearBridgeUploadSelection(), PERSISTENT_BRIDGE_UPLOAD_TTL_MS);
  }

  function prepareBridgeUploadSelection() {
    if (busy) throw new Error("A bulk operation is already running.");
    clearBridgeUploadSelection();
    bridgeUploadSelectionActive = true;
    armBridgeUploadSelectionTimer();
    return Date.now() + PERSISTENT_BRIDGE_UPLOAD_TTL_MS;
  }

  function encodePersistentBridgeResult(value) {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > PERSISTENT_BRIDGE_MAX_RESULT_BYTES) throw new Error("The persistent bridge result was too large.");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function appendPersistentBridgeMarker(marker, kind) {
    const node = document.createElement("output");
    node.className = `cli-bridge-${kind}`;
    node.setAttribute("aria-label", marker);
    node.textContent = marker;
    ui.bridgeResults.appendChild(node);
    return node;
  }

  function emitPersistentBridgeResult(requestId, commandName, state, value) {
    const base = {
      protocolVersion: PERSISTENT_BRIDGE_PROTOCOL_VERSION,
      extensionVersion: PERSISTENT_BRIDGE_EXTENSION_VERSION,
      documentId: bridgeDocumentId,
      requestId,
      targetUrl: window.location.href,
      command: commandName || "unknown",
      state
    };
    let payload = state === "completed" ? { ...base, result: value } : { ...base, error: String(value || "The persistent bridge command failed.").slice(0, 2_000) };
    let encoded;
    try {
      encoded = encodePersistentBridgeResult(payload);
    } catch {
      payload = { ...base, state: "failed", error: "The persistent bridge result was too large." };
      encoded = encodePersistentBridgeResult(payload);
    }
    const readyNode = appendPersistentBridgeMarker(`${PERSISTENT_BRIDGE_RESULT_PREFIX}${requestId}`, "ready");
    const marker = `${PERSISTENT_BRIDGE_RESULT_PREFIX}${requestId}:${encoded}`;
    const node = appendPersistentBridgeMarker(marker, "result");
    const record = persistentBridgeRequests.get(requestId);
    if (record) {
      record.state = payload.state;
      record.resultNode = node;
    }
    window.setTimeout(() => {
      readyNode.remove();
      node.remove();
      if (record) record.resultNode = null;
    }, PERSISTENT_BRIDGE_RESULT_TTL_MS);
  }

  function validatePersistentBridgeEnvelope(value) {
    if (!hasExactBridgeKeys(value, ["protocolVersion", "requestId", "documentId", "targetUrl", "command"])) {
      throw new Error("The persistent bridge request contained unsupported fields.");
    }
    if (value.protocolVersion !== PERSISTENT_BRIDGE_PROTOCOL_VERSION) throw new Error("The persistent bridge protocol version did not match.");
    if (value.targetUrl !== window.location.href) throw new Error("The persistent bridge request was bound to a different page.");
    if (!isPlainBridgeObject(value.command)) throw new Error("The persistent bridge command was invalid.");
    const keys = bridgeCommandKeys(value.command.command);
    if (!keys.length || !hasExactBridgeKeys(value.command, keys)) throw new Error("The persistent bridge command contained unsupported fields.");
    if (value.command.command === "capabilities") {
      if (value.documentId !== "") throw new Error("The initial capability request used an unexpected document identifier.");
    } else if (value.documentId !== bridgeDocumentId) {
      throw new Error("The persistent bridge document identifier did not match this page generation.");
    }
    return value.command;
  }

  function processPersistentBridgeInput() {
    const raw = ui.bridgeCommandInput.value;
    if (!raw) return;
    ui.bridgeCommandInput.value = "";
    ui.bridgeCommandInput.blur();
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    const requestId = envelope?.requestId;
    if (!PERSISTENT_BRIDGE_REQUEST_PATTERN.test(requestId || "")) return;
    if (persistentBridgeRequests.has(requestId)) return;
    if (persistentBridgeRequests.size >= PERSISTENT_BRIDGE_MAX_REQUESTS) return;
    persistentBridgeRequests.set(requestId, { createdAt: Date.now(), state: "pending", resultNode: null });
    const ackNode = appendPersistentBridgeMarker(`${PERSISTENT_BRIDGE_ACK_PREFIX}${requestId}`, "ack");
    window.setTimeout(() => ackNode.remove(), PERSISTENT_BRIDGE_RESULT_TTL_MS);
    let command;
    try {
      command = validatePersistentBridgeEnvelope(envelope);
    } catch (error) {
      emitPersistentBridgeResult(requestId, envelope?.command?.command, "failed", error instanceof Error ? error.message : String(error));
      return;
    }
    Promise.resolve(sendNarrowBridgeCommand(command))
      .then((result) => emitPersistentBridgeResult(requestId, command.command, "completed", result))
      .catch((error) => emitPersistentBridgeResult(requestId, command.command, "failed", error instanceof Error ? error.message : String(error)));
  }

  function planUploadFromNames(names) {
    const requestedNames = parseBridgeNames(names);
    const usedNames = new Set();
    const files = [];
    const skipped = [];
    for (const name of requestedNames) {
      if (usedNames.has(name)) {
        skipped.push({ name, reason: "duplicate requested name" });
        continue;
      }
      usedNames.add(name);
      const file = selectedUploads.find((candidate) => candidate.name === name);
      if (!file) {
        skipped.push({ name, reason: "not selected in the extension file input" });
        continue;
      }
      files.push(file);
    }
    const classified = classifyUploads(files);
    skipped.push(...classified.skipped.map(({ file, reason }) => ({ name: file.name, reason })));
    return {
      operation: "upload",
      requestedNames,
      files: classified.uploadable,
      actionableNames: classified.uploadable.map((file) => file.name),
      skipped,
      inventory: publicInventory()
    };
  }

  function planDeleteFromNames(names) {
    const requestedNames = parseBridgeNames(names);
    const usedNames = new Set();
    const rows = [];
    const skipped = [];
    refreshRows();
    for (const name of requestedNames) {
      if (usedNames.has(name)) {
        skipped.push({ name, reason: "duplicate requested name" });
        continue;
      }
      usedNames.add(name);
      const matches = stagedRows.filter((row) => row.filename === name);
      if (matches.length === 0) {
        skipped.push({ name, reason: "not staged" });
      } else if (matches.length !== 1 || ambiguousRowKeys.has(rowKey(matches[0]))) {
        skipped.push({ name, reason: "ambiguous staged row" });
      } else {
        rows.push(matches[0]);
      }
    }
    return {
      operation: "delete",
      requestedNames,
      rows,
      actionableNames: rows.map((row) => row.filename),
      skipped,
      inventory: publicInventory()
    };
  }

  function planDownloadFromNames(names) {
    const requestedNames = parseBridgeNames(names);
    const usedNames = new Set();
    const rows = [];
    const skipped = [];
    refreshRows();
    for (const name of requestedNames) {
      if (usedNames.has(name)) {
        skipped.push({ name, reason: "duplicate requested name" });
        continue;
      }
      usedNames.add(name);
      const matches = stagedRows.filter((row) => row.filename === name);
      if (matches.length === 0) {
        skipped.push({ name, reason: "not staged" });
      } else if (matches.length !== 1 || ambiguousRowKeys.has(rowKey(matches[0]))) {
        skipped.push({ name, reason: "ambiguous staged row" });
      } else {
        rows.push(matches[0]);
      }
    }
    return {
      operation: "download",
      requestedNames,
      rows,
      actionableNames: rows.map((row) => row.filename),
      skipped,
      inventory: publicInventory()
    };
  }

  function publicPlan(plan) {
    return {
      ok: true,
      issueIdentifier,
      operation: plan.operation,
      requestedNames: plan.requestedNames,
      actionableNames: plan.actionableNames,
      skipped: plan.skipped,
      inventory: plan.inventory
    };
  }

  async function executeBridgeCommand(command) {
    if (!command || typeof command !== "object" || command.issueIdentifier !== issueIdentifier) {
      throw new Error("The command issue identifier did not match this page.");
    }
    if (!Object.prototype.hasOwnProperty.call(command, "command")) throw new Error("The command was missing.");
    if (command.command === "capabilities") {
      return {
        ok: true,
        issueIdentifier,
        persistentBridgeProtocolVersion: PERSISTENT_BRIDGE_PROTOCOL_VERSION,
        extensionVersion: PERSISTENT_BRIDGE_EXTENSION_VERSION,
        documentId: bridgeDocumentId,
        targetUrl: window.location.href
      };
    }
    if (command.command === "status") {
      return { ok: true, issueIdentifier, busy, activeOperation };
    }
    if (command.command === "list") {
      return { ok: true, issueIdentifier, inventory: publicInventory() };
    }
    if (command.command === "prepare-upload") {
      const expiresAt = prepareBridgeUploadSelection();
      return { ok: true, issueIdentifier, expiresAt };
    }
    if (command.command === "cancel-upload") {
      clearBridgeUploadSelection();
      return { ok: true, issueIdentifier, cancelled: true };
    }
    if (command.command === "plan-upload") {
      try {
        if (!bridgeUploadSelectionActive) throw new Error("The persistent upload selection was not prepared or expired.");
        const plan = planUploadFromNames(command.names);
        return { ...publicPlan(plan), authorizationId: bridgePlanStore.create(plan) };
      } finally {
        clearBridgeUploadSelection();
      }
    }
    if (command.command === "plan-delete") {
      const plan = planDeleteFromNames(command.names);
      return { ...publicPlan(plan), authorizationId: bridgePlanStore.create(plan) };
    }
    if (command.command === "plan-download") {
      const plan = planDownloadFromNames(command.names);
      return { ...publicPlan(plan), authorizationId: bridgePlanStore.create(plan) };
    }
    if (command.command === "apply-upload") {
      const plan = bridgePlanStore.consume({ authorizationId: command.authorizationId, operation: "upload", names: command.names });
      if (!plan.files.length) return { ...publicPlan(plan), succeeded: [], failed: [], remaining: [] };
      const result = await startUpload({ files: plan.files, fromBridge: true });
      return { ...publicPlan(plan), ...result, skipped: [...plan.skipped, ...(result?.skipped || [])] };
    }
    if (command.command === "apply-delete") {
      const plan = bridgePlanStore.consume({ authorizationId: command.authorizationId, operation: "delete", names: command.names });
      if (!plan.rows.length) return { ...publicPlan(plan), succeeded: [], failed: [], remaining: [] };
      const result = await startDelete({ rows: plan.rows, fromBridge: true });
      return { ...publicPlan(plan), ...result, skipped: [...plan.skipped, ...(result?.skipped || [])] };
    }
    if (command.command === "apply-download") {
      const plan = bridgePlanStore.consume({ authorizationId: command.authorizationId, operation: "download", names: command.names });
      if (!plan.rows.length) return { ...publicPlan(plan), succeeded: [], failed: [], remaining: [] };
      const result = await startDownload({ rows: plan.rows, fromBridge: true });
      return { ...publicPlan(plan), ...result, skipped: [...plan.skipped, ...(result?.skipped || [])] };
    }
    if (command.command === "stop") {
      if (activeOperation === "delete") deleteStopRequested = true;
      else stopAfterCurrent = true;
      return { ok: true, issueIdentifier, stopped: Boolean(activeOperation), activeOperation };
    }
    throw new Error("The command was not allowed.");
  }

  function sendNarrowBridgeCommand(value) {
    if (!isPlainBridgeObject(value)) return Promise.reject(new Error("The command was invalid."));
    const keys = bridgeCommandKeys(value.command);
    if (!keys.length || !hasExactBridgeKeys(value, keys)) return Promise.reject(new Error("The command contained an unsupported field."));
    const request = { type: COMMAND_REQUEST_MESSAGE, command: value.command, issueIdentifier };
    if (Object.prototype.hasOwnProperty.call(value, "names")) request.names = value.names;
    if (Object.prototype.hasOwnProperty.call(value, "authorizationId")) request.authorizationId = value.authorizationId;
    return chrome.runtime.sendMessage(request);
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    Object.defineProperty(globalThis, BRIDGE_GLOBAL, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ command: sendNarrowBridgeCommand })
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === ZIP_TERMINAL_MESSAGE && message.requestId) {
        const pending = pendingZipRequests.get(message.requestId);
        if (!pending) return false;
        window.clearTimeout(pending.timer);
        pendingZipRequests.delete(message.requestId);
        if (message.ok === true && Number.isInteger(message.downloadId)) {
          if (Number.isInteger(pending.downloadId) && pending.downloadId !== message.downloadId) {
            pending.reject(indeterminateDownloadError("The browser reported a different ZIP download identifier after Save As started.", pending.downloadId));
          } else {
            pending.resolve(message.downloadId);
          }
        } else {
          pending.reject(new Error(message.error || "Edge interrupted the ZIP download."));
        }
        return false;
      }
      if (message?.type !== COMMAND_EXECUTE_MESSAGE || sender?.id !== chrome.runtime.id || sender.tab) return false;
      executeBridgeCommand(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    });
  }

  ui.close.addEventListener("click", closeDialog);
  ui.confirmCancel.addEventListener("click", (event) => {
    if (event.isTrusted) closeConfirmation(false);
  });
  ui.confirmApply.addEventListener("click", (event) => {
    // CDP, scripts, and page code can dispatch click events, but only a real user
    // activation is allowed to release an upload or deletion batch.
    if (event.isTrusted) closeConfirmation(true);
  });
  ui.backdrop.addEventListener("click", (event) => {
    if (event.target === ui.backdrop) closeDialog();
  });
  shadow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (pendingConfirmation) closeConfirmation(false);
      else closeDialog();
    }
  });
  ui.tabs.forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  ui.chooseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!busy) ui.fileInput.click();
  });
  ui.dropZone.addEventListener("click", () => {
    if (!busy) ui.fileInput.click();
  });
  ui.dropZone.addEventListener("keydown", (event) => {
    if (!busy && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      ui.fileInput.click();
    }
  });
  ui.dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    dragDepth += 1;
    ui.dropZone.classList.add("drag-over");
  });
  ui.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
  });
  ui.dropZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropZone.classList.remove("drag-over");
  });
  ui.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    ui.dropZone.classList.remove("drag-over");
    if (busy || !event.dataTransfer) return;

    const items = [...event.dataTransfer.items];
    const containsFolder = items.some((item) => {
      if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") return false;
      return Boolean(item.webkitGetAsEntry()?.isDirectory);
    });
    if (containsFolder) {
      setStatus("Folders are not supported. Drop loose files instead.", "error");
      return;
    }

    const files = [...event.dataTransfer.files].filter((file) => file.name);
    if (!files.length) {
      setStatus("No loose files were found in the drop.", "error");
      return;
    }

    clearBridgeUploadSelection();
    selectedUploads = files;
    ui.fileInput.value = "";
    clearStatus();
    renderUploadFiles();
  });
  ui.fileInput.addEventListener("change", () => {
    clearBridgeUploadSelection();
    selectedUploads = [...ui.fileInput.files];
    clearStatus();
    renderUploadFiles();
  });
  ui.bridgeUploadInput.addEventListener("change", () => {
    const files = [...ui.bridgeUploadInput.files].filter((file) => file.name);
    ui.bridgeUploadInput.value = "";
    ui.bridgeUploadInput.blur();
    if (!bridgeUploadSelectionActive || !files.length) return;
    selectedUploads.push(...files);
    armBridgeUploadSelectionTimer();
    renderUploadFiles();
  });
  ui.bridgeCommandInput.addEventListener("input", () => window.setTimeout(processPersistentBridgeInput, 0));
  window.setInterval(processPersistentBridgeInput, 50);
  window.addEventListener("pagehide", revokeAllRetainedBlobUrls, { once: true });
  ui.uploadAck.addEventListener("change", updateUploadButton);
  ui.uploadButton.addEventListener("click", startUpload);
  ui.downloadButton.addEventListener("click", startDownload);
  ui.deleteButton.addEventListener("click", startDelete);
  ui.downloadSelectAll.addEventListener("click", () => {
    selectedDownloadKeys = new Set(stagedRows
      .filter((row) => !ambiguousRowKeys.has(rowKey(row)))
      .map(rowKey));
    renderDownloadRows();
  });
  ui.downloadSelectNone.addEventListener("click", () => {
    selectedDownloadKeys.clear();
    renderDownloadRows();
  });
  ui.downloadRefresh.addEventListener("click", () => {
    clearStatus();
    refreshRows();
  });
  ui.selectAll.addEventListener("click", () => {
    selectedDeleteKeys = new Set(stagedRows.filter((row) => !ambiguousRowKeys.has(rowKey(row))).map(rowKey));
    renderDeleteRows();
  });
  ui.selectNone.addEventListener("click", () => {
    selectedDeleteKeys.clear();
    renderDeleteRows();
  });
  ui.refresh.addEventListener("click", () => {
    clearStatus();
    refreshRows();
  });
  ui.stopButtons.forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.stopMode === "delete") {
      deleteStopRequested = true;
      button.textContent = "Stopping deletion...";
    } else {
      stopAfterCurrent = true;
      button.textContent = "Will stop after current file";
    }
    ui.stopButtons.forEach((item) => { item.disabled = true; });
  }));

  const pageObserver = new MutationObserver(() => {
    ensureBulkButton();
    if (ui.backdrop.classList.contains("open") && !busy) refreshRows();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  ensureBulkButton();
  refreshRows();
})();
