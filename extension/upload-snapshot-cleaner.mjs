#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import uploadLifetime from "./upload-lifetime.js";
import { inspectPrivateSnapshot, removePrivateSnapshot } from "./upload-snapshot-store.mjs";

async function cleanSnapshotAtDeadline({ directory, nonce, retentionDeadline }, {
  now = () => Date.now(),
  wait = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  inspectSnapshot = inspectPrivateSnapshot,
  removeSnapshot = removePrivateSnapshot
} = {}) {
  if (typeof directory !== "string" || !/^[a-f0-9]{48}$/u.test(nonce || "") || !Number.isSafeInteger(retentionDeadline)) {
    throw new Error("The upload snapshot cleanup request was invalid.");
  }
  const inspected = await inspectSnapshot(directory);
  if (inspected.metadata.nonce !== nonce || inspected.metadata.retentionDeadline !== retentionDeadline) {
    throw new Error("The upload snapshot cleanup metadata did not match.");
  }
  const delayMs = Math.max(0, retentionDeadline - now());
  if (delayMs > uploadLifetime.snapshotCleanerMaxDelayMs) throw new Error("The upload snapshot cleanup deadline was outside its bounded lifetime.");
  if (delayMs) await wait(delayMs);
  if (now() < retentionDeadline) throw new Error("The upload snapshot cleanup clock did not reach the retention deadline.");
  await removeSnapshot(directory, {
    rootPath: inspected.root,
    expectedNonce: nonce,
    expectedDeadline: retentionDeadline
  });
}

async function main() {
  const directory = process.argv[2] || "";
  const nonce = process.argv[3] || "";
  const retentionDeadline = Number(process.argv[4]);
  try {
    await cleanSnapshotAtDeadline({ directory, nonce, retentionDeadline });
  } catch {
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();

export { cleanSnapshotAtDeadline };
