"use strict";

(() => {
  const MINUTE_MS = 60 * 1000;
  const limits = Object.freeze({
    contentBatchTimeoutMs: 120 * MINUTE_MS,
    cliApplyTimeoutMs: 130 * MINUTE_MS,
    snapshotBuildTimeoutMs: 60 * MINUTE_MS,
    snapshotTransferLeaseMs: 10 * MINUTE_MS,
    snapshotSafetyMarginMs: 30 * MINUTE_MS,
    snapshotRetentionMs: 150 * MINUTE_MS,
    snapshotCleanerMaxDelayMs: 180 * MINUTE_MS
  });

  if (limits.contentBatchTimeoutMs >= limits.cliApplyTimeoutMs
    || limits.snapshotTransferLeaseMs <= 5 * MINUTE_MS + 70 * 1000
    || limits.snapshotRetentionMs < limits.contentBatchTimeoutMs + limits.snapshotSafetyMarginMs
    || limits.snapshotRetentionMs > limits.snapshotCleanerMaxDelayMs) {
    throw new Error("The upload lifetime limits were unsafe.");
  }

  Object.defineProperty(globalThis, "TealEvalUploadLifetime", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: limits
  });

  if (typeof module !== "undefined" && module.exports) module.exports = limits;
})();
