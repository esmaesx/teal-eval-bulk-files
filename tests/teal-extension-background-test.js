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
let downloadCalls = 0;
let fetched = [];
const changeListeners = new Set();
const sessionStorage = {};
const terminalMessages = [];
const commandMessages = [];
let rejectSessionSet = false;
let rejectCommandResponse = false;

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
        downloadCalls += 1;
        downloadOptions = options;
        callback(42);
      },
      search: (_query, callback) => callback([{ id: 42, state: "complete" }])
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStorage[key] }),
        set: async (values) => {
          if (rejectSessionSet) throw new Error("mock session storage rejected the write");
          Object.assign(sessionStorage, values);
        },
        remove: async (key) => { delete sessionStorage[key]; }
      }
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        if (message.type === "teal-eval-bulk-command-execute-v1") {
          commandMessages.push({ tabId, message });
          if (rejectCommandResponse) throw new Error("mock apply response channel closed");
          return { ok: true };
        }
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

  rejectSessionSet = true;
  const callsBeforeIndeterminate = downloadCalls;
  const messagesBeforeIndeterminate = terminalMessages.length;
  const indeterminateMessage = {
    ...message,
    requestId: "44444444-4444-4444-8444-444444444444"
  };
  const indeterminate = await send(indeterminateMessage);
  assert.equal(indeterminate.ok, false);
  assert.equal(indeterminate.started, true);
  assert.equal(indeterminate.indeterminate, true);
  assert.equal(indeterminate.requestId, indeterminateMessage.requestId);
  assert.equal(indeterminate.downloadId, 42);
  assert.match(indeterminate.error, /started.*could not track|session storage rejected/iu);
  assert.equal(downloadCalls, callsBeforeIndeterminate + 1, "the background must not retry a started download");
  assert.equal(Object.keys(sessionStorage).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminalMessages.length, messagesBeforeIndeterminate, "an untracked download must not report a false terminal result");

  rejectCommandResponse = true;
  const applyResponseLoss = await send({
    type: "teal-eval-bulk-command-v1",
    command: "apply-download",
    issueIdentifier: "TAB-TEST",
    names: [staged.filename],
    authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  });
  assert.equal(applyResponseLoss.ok, false);
  assert.equal(applyResponseLoss.indeterminate, true);
  assert.match(applyResponseLoss.error, /dispatched.*response channel failed.*may still be running/iu);
  assert.equal(commandMessages.filter(({ message: value }) => value.command === "apply-download").length, 1);

  const listResponseLoss = await send({
    type: "teal-eval-bulk-command-v1",
    command: "list",
    issueIdentifier: "TAB-TEST"
  });
  assert.equal(listResponseLoss.ok, false);
  assert.equal(listResponseLoss.indeterminate, undefined);
  assert.match(listResponseLoss.error, /mock apply response channel closed/u);

  console.log("background tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
