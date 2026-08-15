"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const backgroundPath = path.join(__dirname, "..", "extension", "background.js");
const source = fs.readFileSync(backgroundPath, "utf8");
const staged = {
  id: "ed1df85c-04ae-4bcd-9ae4-ee87c6ae766b",
  filename: "ZTB1147-201_PopPK_Model_Delivery.zip",
  sha256: "a".repeat(64)
};
let listener;
let downloadOptions;
let fetched = [];
const changeListeners = new Set();
const sessionStorage = {};
const terminalMessages = [];

const context = {
  URL,
  console,
  setTimeout,
  clearTimeout,
  fetch: async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, json: async () => ({ rows: [staged] }) };
  },
  chrome: {
    runtime: {
      id: "test-extension",
      lastError: null,
      getManifest: () => ({
        content_scripts: [{ matches: ["https://platform-teal-alpha.vercel.app/issue/*"] }]
      }),
      onMessage: { addListener: (value) => { listener = value; } }
    },
    downloads: {
      onChanged: {
        addListener: (value) => changeListeners.add(value),
        removeListener: (value) => changeListeners.delete(value)
      },
      download: (options, callback) => {
        downloadOptions = options;
        callback(42);
      },
      search: (_query, callback) => callback([{ id: 42, state: "complete" }])
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStorage[key] }),
        set: async (values) => Object.assign(sessionStorage, values),
        remove: async (key) => { delete sessionStorage[key]; }
      }
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        terminalMessages.push({ tabId, message });
      }
    }
  }
};

vm.runInNewContext(source, context, { filename: backgroundPath });
assert.equal(typeof listener, "function");

const sender = {
  id: "test-extension",
  frameId: 0,
  tab: { id: 314, url: "https://platform-teal-alpha.vercel.app/issue/TAB-TEST" }
};
const entry = { stagedId: staged.id, filename: staged.filename, sha256: staged.sha256 };
const message = {
  type: "teal-eval-bulk-save-zip-v1",
  requestId: "11111111-1111-4111-8111-111111111111",
  batchId: "22222222-2222-4222-8222-222222222222",
  sequence: 0,
  issueIdentifier: "TAB-TEST",
  entries: [entry],
  archiveFilename: "TAB-TEST-staged-files-2026-08-14.zip",
  blobUrl: "blob:https://platform-teal-alpha.vercel.app/33333333-3333-4333-8333-333333333333"
};

function send(value, from = sender) {
  return new Promise((resolve) => {
    const asynchronous = listener(value, from, resolve);
    if (!asynchronous) setImmediate(() => resolve(undefined));
  });
}

(async () => {
  const success = await send(message);
  assert.equal(success.ok, true);
  assert.equal(success.started, true);
  assert.equal(success.requestId, message.requestId);
  assert.equal(success.downloadId, 42);
  assert.equal(fetched.length, 1);
  assert.equal(changeListeners.size, 1);
  assert.equal(JSON.stringify(downloadOptions), JSON.stringify({
    url: message.blobUrl,
    filename: message.archiveFilename,
    saveAs: true,
    conflictAction: "uniquify"
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminalMessages.length, 1);
  assert.equal(terminalMessages[0].tabId, 314);
  assert.equal(terminalMessages[0].message.ok, true);
  assert.equal(Object.keys(sessionStorage).length, 0);

  fetched = [];
  const wrongFrame = await send(message, { ...sender, frameId: 1 });
  assert.equal(wrongFrame.ok, false);
  assert.equal(fetched.length, 0);

  const unsafeName = await send({ ...message, archiveFilename: "..\\escape.zip" });
  assert.equal(unsafeName.ok, false);
  assert.equal(fetched.length, 0);

  const wrongOrigin = await send({ ...message, blobUrl: "blob:https://evil.example/archive" });
  assert.equal(wrongOrigin.ok, false);
  assert.equal(fetched.length, 0);

  const wrongIdentity = await send({ ...message, entries: [{ ...entry, sha256: "b".repeat(64) }] });
  assert.equal(wrongIdentity.ok, false);
  assert.equal(fetched.length, 1);

  console.log("background tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
