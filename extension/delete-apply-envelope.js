"use strict";

(() => {
  function sanitizeObservationError(value) {
    const text = value instanceof Error ? value.message : String(value || "The staged-file inventory could not be observed.");
    return text
      .replace(/\b(?:https?|chrome|edge|devtools):\/\/\S+/giu, "[url]")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500) || "The staged-file inventory could not be observed.";
  }

  function sameInventory(left, right) {
    return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
  }

  function observeReadyInventory({ findPanel, isLoading, refreshRows, snapshotInventory }) {
    if (typeof findPanel !== "function" || typeof isLoading !== "function" || typeof refreshRows !== "function" || typeof snapshotInventory !== "function") {
      throw new Error("The staged-file inventory observer was invalid.");
    }
    const panelBefore = findPanel();
    if (!panelBefore) throw new Error("The staged-files panel is not present.");
    if (isLoading(panelBefore)) throw new Error("The staged-files panel is still loading.");
    refreshRows();
    const panelAfter = findPanel();
    if (!panelAfter) throw new Error("The staged-files panel disappeared during inventory observation.");
    if (panelBefore?.container && panelAfter?.container && panelBefore.container !== panelAfter.container) {
      throw new Error("The staged-files panel changed during inventory observation.");
    }
    if (isLoading(panelAfter)) throw new Error("The staged-files panel is still loading after refresh.");
    const inventory = snapshotInventory();
    if (!Array.isArray(inventory)) throw new Error("The staged-file inventory snapshot was invalid.");
    return inventory;
  }

  function actionableNames(plan) {
    if (Array.isArray(plan?.actionableNames)) return plan.actionableNames.filter((name) => typeof name === "string");
    if (Array.isArray(plan?.rows)) return plan.rows.map((row) => row?.filename).filter((name) => typeof name === "string");
    return [];
  }

  function terminalFailure(names, message) {
    return {
      succeeded: [],
      skipped: [],
      failed: names.map((name) => ({ name, error: message })),
      remaining: [...names]
    };
  }

  function normalizeTerminalResult(value, names) {
    if (!value || typeof value !== "object") {
      return terminalFailure(names, "The delete operation returned no terminal result.");
    }
    const succeeded = Array.isArray(value.succeeded) ? value.succeeded : [];
    const skipped = Array.isArray(value.skipped) ? value.skipped : [];
    const failed = Array.isArray(value.failed) ? value.failed : [];
    const remaining = Array.isArray(value.remaining) ? value.remaining : names.filter((name) => !succeeded.includes(name));
    const complete = [value.succeeded, value.skipped, value.failed, value.remaining].every(Array.isArray);
    return {
      ...value,
      succeeded,
      skipped,
      failed: complete ? failed : [...failed, { name: remaining[0] || "", error: "The delete operation returned an incomplete terminal result." }],
      remaining
    };
  }

  async function executeDeleteApply({ plan, readInventory, startDelete }) {
    if (!plan || typeof plan !== "object" || typeof readInventory !== "function" || typeof startDelete !== "function") {
      throw new Error("The delete apply envelope inputs were invalid.");
    }
    const names = actionableNames(plan);
    let inventoryBefore;
    try {
      inventoryBefore = await readInventory();
    } catch (error) {
      const inventoryObservationError = sanitizeObservationError(error);
      return {
        ok: false,
        operation: "delete",
        ...terminalFailure(names, "The staged-file inventory could not be checked. No mutation was started."),
        error: "The staged-file inventory could not be checked. No mutation was started.",
        inventoryBefore: null,
        inventoryAfter: null,
        inventory: null,
        inventoryObservationError,
        needsReadOnlyList: true,
        replayAllowed: false
      };
    }

    if (!sameInventory(inventoryBefore, plan.inventory)) {
      const message = "The staged-file inventory changed after authorization. No mutation was started.";
      return {
        ok: false,
        operation: "delete",
        ...terminalFailure(names, message),
        inventoryBefore,
        inventoryAfter: inventoryBefore,
        inventory: inventoryBefore,
        error: message,
        needsReadOnlyList: false,
        replayAllowed: false
      };
    }

    let terminal;
    if (!plan.rows?.length) {
      terminal = { succeeded: [], skipped: [], failed: [], remaining: [] };
    } else {
      try {
        terminal = normalizeTerminalResult(await startDelete({ rows: plan.rows, fromBridge: true }), names);
      } catch (error) {
        const deleteOperationError = sanitizeObservationError(error);
        terminal = terminalFailure(names, deleteOperationError);
        terminal.error = "The delete operation rejected after dispatch. Its mutation state is uncertain. Run a read-only list. Do not replay this apply.";
        terminal.deleteOperationError = deleteOperationError;
        terminal.indeterminate = true;
      }
    }

    let inventoryAfter;
    try {
      inventoryAfter = await readInventory();
    } catch (error) {
      return {
        ...terminal,
        ok: false,
        operation: "delete",
        indeterminate: true,
        error: "The delete operation reached a terminal result, but the post-operation inventory could not be observed. Run a read-only list. Do not replay this apply.",
        inventoryBefore,
        inventoryAfter: null,
        inventory: null,
        inventoryObservationError: sanitizeObservationError(error),
        needsReadOnlyList: true,
        replayAllowed: false
      };
    }

    const operationFailed = terminal.cancelled === true || terminal.failed.length > 0 || terminal.remaining.length > 0;
    return {
      ...terminal,
      ok: terminal.ok !== false && !operationFailed,
      operation: "delete",
      inventoryBefore,
      inventoryAfter,
      inventory: inventoryAfter,
      needsReadOnlyList: operationFailed,
      replayAllowed: false
    };
  }

  const api = Object.freeze({ executeDeleteApply, observeReadyInventory, sanitizeObservationError, sameInventory });
  Object.defineProperty(globalThis, "TealEvalDeleteApply", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api
  });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TealEvalDeleteApply;
})();
