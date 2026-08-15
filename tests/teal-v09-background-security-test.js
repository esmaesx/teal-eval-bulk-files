"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
let listener;
let manifest = { content_scripts: [{ matches: ["https://platform-teal-alpha.vercel.app/issue/*"] }] };
let routed = [];
let injected = [];
let mode = "exact";
let originalConfirmCalls = 0;

function makeDocument() {
  const removeButton = {
    textContent: "remove",
    click() {
      if (mode === "none") return;
      if (mode === "wrong") context.window.confirm("Wrong prompt");
      else if (mode === "repeated") {
        context.window.confirm("Remove this staged file? Active runs may still reference it.");
        context.window.confirm("Remove this staged file? Active runs may still reference it.");
      } else {
        context.window.confirm("Remove this staged file? Active runs may still reference it.");
      }
    }
  };
  const hash = { getAttribute: () => "a".repeat(64) };
  const row = {
    querySelectorAll(selector) {
      if (selector === "td") return [{ textContent: "file.txt" }, {}, { querySelector: () => hash, textContent: "a".repeat(64) }];
      if (selector === "button") return [removeButton];
      return [];
    }
  };
  return { querySelectorAll: (selector) => selector === "table tbody tr" ? [row] : [] };
}

const originalConfirm = () => { originalConfirmCalls += 1; return false; };
const context = {
  URL,
  console,
  window: { confirm: originalConfirm },
  document: makeDocument(),
  chrome: {
    runtime: {
      id: "test-extension",
      lastError: null,
      getManifest: () => manifest,
      onMessage: { addListener: (value) => { listener = value; } }
    },
    downloads: { onChanged: { addListener() {} } },
    scripting: {
      executeScript: async (options) => {
        injected.push(options);
        return [{ result: options.func(...options.args) }];
      }
    },
    tabs: {
      sendMessage: async (_tabId, message) => {
        routed.push(message);
        return { ok: true, received: message.command };
      }
    }
  }
};
vm.runInNewContext(source, context, { filename: "background.js" });
assert.equal(typeof listener, "function");

function sender(url) {
  return { id: "test-extension", frameId: 0, tab: { id: 9, url } };
}

function send(message, from) {
  return new Promise((resolve) => {
    const async = listener(message, from, resolve);
    if (!async) setImmediate(() => resolve(undefined));
  });
}

(async () => {
  const valid = sender("https://platform-teal-alpha.vercel.app/issue/TAB-TEST");
  const command = { type: "teal-eval-bulk-command-v1", command: "status", issueIdentifier: "TAB-TEST" };
  const allowed = await send(command, valid);
  assert.equal(allowed.ok, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].type, "teal-eval-bulk-command-execute-v1");

  const rejectedHost = await send(command, sender("https://evil.example/issue/TAB-TEST"));
  assert.equal(rejectedHost.ok, false);
  const rejectedPath = await send(command, sender("https://platform-teal-alpha.vercel.app/not-issue/TAB-TEST"));
  assert.equal(rejectedPath.ok, false);
  const rejectedFrame = await send(command, { ...valid, frameId: 1 });
  assert.equal(rejectedFrame.ok, false);
  const rejectedPayload = await send({ ...command, selector: "button" }, valid);
  assert.equal(rejectedPayload.ok, false);

  manifest = { content_scripts: [{ matches: ["<all_urls>", "https://*.example.test/issue/*", "https://platform-teal-alpha.vercel.app/not-issue/*"] }] };
  const wildcardRejected = await send(command, valid);
  assert.equal(wildcardRejected.ok, false);

  manifest = { content_scripts: [{ matches: ["http://127.0.0.1:8769/issue/*"] }] };
  const local = sender("http://127.0.0.1:8769/issue/TAB-TEST");
  const localAllowed = await send(command, local);
  assert.equal(localAllowed.ok, true);

  const deleteRequest = { type: "teal-eval-bulk-native-delete-v1", issueIdentifier: "TAB-TEST", filename: "file.txt", sha256: "a".repeat(64) };
  for (const expectedMode of ["exact", "wrong", "repeated", "none"]) {
    mode = expectedMode;
    context.window.confirm = originalConfirm;
    const response = await send(deleteRequest, local);
    assert.equal(response.ok, expectedMode === "exact", expectedMode);
    assert.equal(context.window.confirm, originalConfirm, `${expectedMode} restores confirm`);
  }
  assert.equal(injected.length, 4);
  assert.equal(injected.every((entry) => entry.world === "MAIN" && entry.target.frameIds[0] === 0), true);
  assert.equal(originalConfirmCalls, 0);
  console.log("v0.9 background security tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
