"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { executeDeleteApply, observeReadyInventory } = require("../extension/delete-apply-envelope.js");

const alpha = { filename: "alpha.txt", sha256: "a".repeat(64), sizeText: "1 B" };
const beta = { filename: "beta.txt", sha256: "b".repeat(64), sizeText: "2 B" };

function plan(rows = [alpha]) {
  return {
    operation: "delete",
    rows,
    actionableNames: rows.map((row) => row.filename),
    inventory: [alpha, beta]
  };
}

test("delete inventory observation requires a present non-loading panel and refreshes once", () => {
  let refreshes = 0;
  const readyPanel = { state: "ready" };
  assert.deepEqual(observeReadyInventory({
    findPanel: () => readyPanel,
    isLoading: () => false,
    refreshRows: () => { refreshes += 1; },
    snapshotInventory: () => []
  }), []);
  assert.equal(refreshes, 1, "a present empty panel is a valid refreshed empty inventory");

  assert.throws(() => observeReadyInventory({
    findPanel: () => null,
    isLoading: () => false,
    refreshRows: () => { refreshes += 1; },
    snapshotInventory: () => []
  }), /not present/u);
  assert.equal(refreshes, 1, "an absent panel must fail before refresh or mutation");

  assert.throws(() => observeReadyInventory({
    findPanel: () => readyPanel,
    isLoading: () => true,
    refreshRows: () => { refreshes += 1; },
    snapshotInventory: () => []
  }), /still loading/u);
  assert.equal(refreshes, 1, "a loading panel must fail before refresh or mutation");
});

test("delete inventory observation checks panel readiness again after refresh", () => {
  let reads = 0;
  assert.throws(() => observeReadyInventory({
    findPanel: () => ({ read: ++reads }),
    isLoading: (panel) => panel.read === 2,
    refreshRows: () => {},
    snapshotInventory: () => []
  }), /loading after refresh/u);
  assert.equal(reads, 2);
});

test("inventory observation fails if refresh replaces the staged-files panel", () => {
  const firstContainer = {};
  const secondContainer = {};
  let reads = 0;
  assert.throws(() => observeReadyInventory({
    findPanel: () => ({ container: ++reads === 1 ? firstContainer : secondContainer }),
    isLoading: () => false,
    refreshRows: () => {},
    snapshotInventory: () => []
  }), /panel changed/u);
  assert.equal(reads, 2);
});

test("apply-delete no-op observes an exact before and after inventory without dispatch", async () => {
  let refreshes = 0;
  let dispatches = 0;
  const result = await executeDeleteApply({
    plan: plan([]),
    readInventory: async () => { refreshes += 1; return [alpha, beta]; },
    startDelete: async () => { dispatches += 1; }
  });
  assert.equal(result.ok, true);
  assert.equal(refreshes, 2);
  assert.equal(dispatches, 0);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.inventoryBefore, [alpha, beta]);
  assert.deepEqual(result.inventoryAfter, [alpha, beta]);
  assert.deepEqual(result.inventory, result.inventoryAfter);
});

test("apply-delete full success refreshes both observations and reports the exact post-operation inventory", async () => {
  let refreshes = 0;
  const result = await executeDeleteApply({
    plan: plan(),
    readInventory: async () => { refreshes += 1; return refreshes === 1 ? [alpha, beta] : [beta]; },
    startDelete: async ({ rows, fromBridge }) => {
      assert.deepEqual(rows, [alpha]);
      assert.equal(fromBridge, true);
      return { operation: "delete", succeeded: [alpha.filename], skipped: [], failed: [], remaining: [] };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(refreshes, 2);
  assert.deepEqual(result.inventoryBefore, [alpha, beta]);
  assert.deepEqual(result.inventoryAfter, [beta]);
  assert.deepEqual(result.inventory, [beta]);
  assert.equal(result.replayAllowed, false);
});

test("apply-delete partial failure preserves terminal arrays and post-operation inventory", async () => {
  const both = plan([alpha, beta]);
  const result = await executeDeleteApply({
    plan: both,
    readInventory: (() => {
      let reads = 0;
      return async () => (++reads === 1 ? [alpha, beta] : [beta]);
    })(),
    startDelete: async () => ({
      operation: "delete",
      succeeded: [alpha.filename],
      skipped: [],
      failed: [{ name: beta.filename, error: "Remove control failed." }],
      remaining: [beta.filename]
    })
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.succeeded, [alpha.filename]);
  assert.deepEqual(result.failed, [{ name: beta.filename, error: "Remove control failed." }]);
  assert.deepEqual(result.remaining, [beta.filename]);
  assert.deepEqual(result.inventoryAfter, [beta]);
  assert.deepEqual(result.inventory, result.inventoryAfter);
  assert.equal(result.needsReadOnlyList, true);
});

test("unexpected startDelete rejection after possible mutation is indeterminate and cannot replay", async () => {
  let refreshes = 0;
  let dispatches = 0;
  const result = await executeDeleteApply({
    plan: plan(),
    readInventory: async () => { refreshes += 1; return refreshes === 1 ? [alpha, beta] : [beta]; },
    startDelete: async () => {
      dispatches += 1;
      throw new Error("unexpected rejection at https://secret.example/delete\u0000");
    }
  });
  assert.equal(refreshes, 2);
  assert.equal(dispatches, 1);
  assert.equal(result.ok, false);
  assert.equal(result.indeterminate, true);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.failed, [{ name: alpha.filename, error: "unexpected rejection at [url]" }]);
  assert.deepEqual(result.remaining, [alpha.filename]);
  assert.deepEqual(result.inventoryBefore, [alpha, beta]);
  assert.deepEqual(result.inventoryAfter, [beta]);
  assert.deepEqual(result.inventory, [beta]);
  assert.equal(result.needsReadOnlyList, true);
  assert.equal(result.replayAllowed, false);
  assert.match(result.error, /mutation state is uncertain/u);
  assert.doesNotMatch(result.deleteOperationError, /secret\.example/u);
});

test("apply-delete inventory mismatch fails closed with zero delete dispatch", async () => {
  let dispatches = 0;
  const observed = [alpha];
  const result = await executeDeleteApply({
    plan: plan(),
    readInventory: async () => observed,
    startDelete: async () => { dispatches += 1; }
  });
  assert.equal(dispatches, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /inventory changed/u);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.remaining, [alpha.filename]);
  assert.deepEqual(result.inventoryBefore, observed);
  assert.deepEqual(result.inventoryAfter, observed);
  assert.deepEqual(result.inventory, observed);
});

test("apply-delete post-observation failure keeps terminal arrays and removes sensitive detail", async () => {
  let reads = 0;
  const result = await executeDeleteApply({
    plan: plan(),
    readInventory: async () => {
      reads += 1;
      if (reads === 1) return [alpha, beta];
      throw new Error("observer\u0000 failed at https://secret.example/token");
    },
    startDelete: async () => ({ operation: "delete", succeeded: [alpha.filename], skipped: [], failed: [], remaining: [] })
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.succeeded, [alpha.filename]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.inventoryBefore, [alpha, beta]);
  assert.equal(result.inventoryAfter, null);
  assert.equal(result.inventory, null);
  assert.equal(result.indeterminate, true);
  assert.equal(result.needsReadOnlyList, true);
  assert.equal(result.replayAllowed, false);
  assert.match(result.error, /read-only list/u);
  assert.match(result.error, /Do not replay/u);
  assert.doesNotMatch(result.inventoryObservationError, /secret\.example/u);
  assert.match(result.inventoryObservationError, /\[url\]/u);
});

test("apply-delete pre-observation failure does not dispatch a mutation", async () => {
  let dispatches = 0;
  const result = await executeDeleteApply({
    plan: plan(),
    readInventory: async () => { throw new Error("inventory observer failed"); },
    startDelete: async () => { dispatches += 1; }
  });
  assert.equal(dispatches, 0);
  assert.equal(result.ok, false);
  assert.equal(result.inventoryBefore, null);
  assert.equal(result.inventoryAfter, null);
  assert.equal(result.inventory, null);
  assert.equal(result.needsReadOnlyList, true);
  assert.match(result.error, /No mutation was started/u);
  assert.deepEqual(result.remaining, [alpha.filename]);
});
