"use strict";

const assert = require("node:assert/strict");
const { createStore } = require("../extension/bridge-plan-store.js");

const idPattern = /^[A-Za-z0-9-]{16,80}$/;
let clock = 1_000;
let inventory = [{ filename: "alpha.txt", sha256: "a".repeat(64), sizeText: "10 B" }];
let nextId = 0;

function makeStore(ttlMs = 100) {
  return createStore({
    ttlMs,
    authorizationPattern: idPattern,
    createAuthorizationId: () => `11111111-1111-4111-8111-${String(++nextId).padStart(12, "0")}`,
    now: () => clock,
    getInventory: () => inventory.map((row) => ({ ...row })),
    parseNames: (names) => {
      if (!Array.isArray(names) || !names.length || !names.every((name) => typeof name === "string" && name)) {
        throw new Error("The command names were invalid.");
      }
      return [...names];
    }
  });
}

function uploadPlan(file) {
  return {
    operation: "upload",
    requestedNames: [file.name],
    files: [file],
    rows: [],
    actionableNames: [file.name],
    skipped: [],
    inventory: inventory.map((row) => ({ ...row }))
  };
}

const originalFile = Object.freeze({ name: "planned.txt", size: 12, lastModified: 77 });
const replacementFile = Object.freeze({ name: "planned.txt", size: 99, lastModified: 88 });
let selectedFile = originalFile;
const store = makeStore();
const authorizationId = store.create(uploadPlan(selectedFile));
selectedFile = replacementFile;
const consumed = store.consume({ authorizationId, operation: "upload", names: ["planned.txt"] });
assert.equal(consumed.files[0], originalFile);
assert.notEqual(consumed.files[0], selectedFile);
assert.throws(() => store.consume({ authorizationId, operation: "upload", names: ["planned.txt"] }), /already used|not found/i);
assert.throws(() => store.consume({ authorizationId: "22222222-2222-4222-8222-222222222222", operation: "upload", names: ["planned.txt"] }), /not found/i);
assert.throws(() => store.consume({ authorizationId: "bad", operation: "upload", names: ["planned.txt"] }), /invalid/i);

const wrongNameStore = makeStore();
const wrongNameId = wrongNameStore.create(uploadPlan(originalFile));
assert.throws(() => wrongNameStore.consume({ authorizationId: wrongNameId, operation: "upload", names: ["other.txt"] }), /did not match/i);
assert.throws(() => wrongNameStore.consume({ authorizationId: wrongNameId, operation: "upload", names: ["planned.txt"] }), /already used|not found/i);

const wrongOperationStore = makeStore();
const wrongOperationId = wrongOperationStore.create(uploadPlan(originalFile));
assert.throws(() => wrongOperationStore.consume({ authorizationId: wrongOperationId, operation: "delete", names: ["planned.txt"] }), /did not match/i);

const driftStore = makeStore();
const driftId = driftStore.create(uploadPlan(originalFile));
inventory = [{ filename: "changed.txt", sha256: "b".repeat(64), sizeText: "11 B" }];
assert.throws(() => driftStore.consume({ authorizationId: driftId, operation: "upload", names: ["planned.txt"] }), /inventory changed/i);

inventory = [{ filename: "alpha.txt", sha256: "a".repeat(64), sizeText: "10 B" }];
const expiredStore = makeStore(25);
const expiredId = expiredStore.create(uploadPlan(originalFile));
clock += 26;
assert.throws(() => expiredStore.consume({ authorizationId: expiredId, operation: "upload", names: ["planned.txt"] }), /expired/i);

assert.throws(() => createStore({
  ttlMs: 0,
  authorizationPattern: idPattern,
  createAuthorizationId: () => "11111111-1111-4111-8111-111111111111",
  now: () => clock,
  getInventory: () => inventory,
  parseNames: (names) => names
}), /lifetime/i);

console.log("bridge plan authorization runtime tests passed");
