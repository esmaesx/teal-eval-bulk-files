import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import uploadLifetime from "../extension/upload-lifetime.js";
import { cleanSnapshotAtDeadline } from "../extension/upload-snapshot-cleaner.mjs";
import {
  createPrivateSnapshotContainer,
  finalizePrivateSnapshot,
  inspectPrivateSnapshot,
  removePrivateSnapshot
} from "../extension/upload-snapshot-store.mjs";

import {
  applyPlan,
  bridgeErrorOutput,
  classifyCommandResult,
  createVerifiedUploadSnapshot,
  createPlan,
  daemonRecoveryError,
  inspectUploadFiles,
  parseArguments,
  selectAllowedTarget,
  verifyFiles
} from "../extension/teal-eval-bulk-cli.mjs";

function row(filename, sha256, sizeText = "4 B") {
  return { filename, sha256, sizeText };
}

function directClient({
  inventory,
  afterTransferInventory = inventory,
  afterApplyInventory = afterTransferInventory,
  applyUploadResult = null,
  failureAtHiddenInput = false,
  terminalFailureCommand = "",
  exceptionDetailsCommand = "",
  onBeforeHiddenInput = null,
  inspectSelectedFile = null
} = {}) {
  const calls = [];
  const bridgeCommands = [];
  const retainedSnapshots = [];
  let listCount = 0;
  let applyCalled = false;
  return {
    mode: "direct",
    targetId: "target_7",
    targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
    targetTitle: "TAB-TEST local fixture",
    documentId: "",
    sessionId: null,
    async retainUploadSnapshotForTest(snapshot) {
      retainedSnapshots.push(snapshot.actionableFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, size: file.size })));
      await rm(snapshot.directory, { recursive: true, force: true });
    },
    calls,
    bridgeCommands,
    retainedSnapshots,
    async request(method, params) {
      if (method === "DOM.getDocument") {
        if (typeof onBeforeHiddenInput === "function") await onBeforeHiddenInput();
        return { root: { children: [{ nodeName: "INPUT", nodeId: 44, attributes: ["class", "cli-bridge-upload"] }] } };
      }
      if (method === "DOM.setFileInputFiles") {
        calls.push("hidden-input");
        assert.equal(params.nodeId, 44);
        assert.equal(params.files.length, 1);
        if (typeof inspectSelectedFile === "function") await inspectSelectedFile(params.files[0]);
        if (failureAtHiddenInput) throw new Error("hidden input transport failed");
        return {};
      }
      assert.equal(method, "Runtime.callFunctionOn");
      const command = params.arguments[0].value;
      calls.push(command.command);
      bridgeCommands.push(command);
      if (command.command === exceptionDetailsCommand) return { exceptionDetails: { text: `${command.command} rejected after dispatch` } };
      if (command.command === "list") {
        listCount += 1;
        return { result: { value: { ok: true, inventory: applyCalled ? afterApplyInventory : (listCount > 1 ? afterTransferInventory : inventory) } } };
      }
      if (command.command === "prepare-upload") return { result: { value: { ok: true } } };
      if (command.command === terminalFailureCommand) {
        const error = new Error(`${command.command} returned a terminal failure`);
        error.confirmedTerminal = true;
        throw error;
      }
      if (command.command === "plan-upload") return { result: { value: { ok: true, authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } } };
      if (command.command === "apply-upload") {
        applyCalled = true;
        return { result: { value: applyUploadResult || { ok: true, operation: "upload", succeeded: command.names, skipped: [], failed: [], remaining: [] } } };
      }
      if (command.command === "apply-download" || command.command === "apply-delete") {
        applyCalled = true;
        return { result: { value: { ok: true, operation: command.command.slice("apply-".length), succeeded: command.names, skipped: [], failed: [], remaining: [] } } };
      }
      throw new Error(`unexpected bridge command ${command.command}`);
    }
  };
}

function uploadRecord(file, inventory, now = Date.now()) {
  return {
    tokenSchemaVersion: 2,
    issueIdentifier: "TAB-TEST",
    operation: "upload",
    targetId: "target_7",
    targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
    targetTitle: "TAB-TEST local fixture",
    connectionMode: "direct",
    bridgeDocumentId: "",
    requestedNames: [file.filename],
    actionableNames: [file.filename],
    actionableFiles: [{ absolutePath: file.absolutePath, filename: file.filename, size: file.size, sha256: file.sha256 }],
    skipped: [],
    inventory,
    issuedAt: now,
    expiresAt: now + 60_000,
    consumed: false
  };
}

test("post-finalize inspection failure cleans with the finalized nonce and deadline", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-post-finalize-failure-"));
  const sourcePath = join(temp, "authorized.txt");
  const snapshotDirectory = join(temp, "snapshot");
  const nonce = "e".repeat(48);
  const retentionDeadline = Date.now() + 60_000;
  let removed = null;
  try {
    await writeFile(sourcePath, "authorized bytes", "utf8");
    await mkdir(snapshotDirectory);
    const [file] = await inspectUploadFiles([sourcePath]);
    await assert.rejects(() => createVerifiedUploadSnapshot([file], {
      createContainer: async () => ({
        root: temp,
        directory: snapshotDirectory,
        nonce,
        retentionDeadline: null
      }),
      finalizeSnapshot: async (container) => ({ ...container, retentionDeadline }),
      inspectSnapshot: async () => { throw new Error("injected post-finalize inspection failure"); },
      removeSnapshot: async (directory, options) => {
        removed = { directory, ...options };
        await rm(directory, { recursive: true, force: false });
      }
    }), /injected post-finalize inspection failure/u);
    assert.deepEqual(removed, {
      directory: snapshotDirectory,
      rootPath: temp,
      expectedNonce: nonce,
      expectedDeadline: retentionDeadline
    });
    await assert.rejects(readFile(join(snapshotDirectory, file.filename)), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function readState(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runRaceWorker(args) {
  const workerPath = fileURLToPath(new URL("./token-state-race-worker.mjs", import.meta.url));
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function releaseRaceWhenReady(readyPaths, releasePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(readyPaths.map((path) => readFile(path, "utf8").then(() => true).catch(() => false)));
    if (ready.every(Boolean)) {
      await writeFile(releasePath, "go", "utf8");
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("The token race workers did not become ready.");
}

test("plan-upload is read-only and writes a v2 token with local SHA-256 evidence", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-plan-"));
  try {
    const statePath = join(temp, "tokens.json");
    const uploadPath = join(temp, "proof.txt");
    await writeFile(uploadPath, "proof", "utf8");
    const client = directClient({ inventory: [] });
    const cli = { command: "plan-upload", operands: [uploadPath], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 };
    const result = await createPlan(cli, client, 9);
    assert.deepEqual(client.calls, ["list"]);
    assert.equal(result.actionableNames[0], "proof.txt");
    const record = (await readState(statePath)).tokens[result.token];
    assert.equal(record.tokenSchemaVersion, 2);
    assert.deepEqual(Object.keys(record.actionableFiles[0]).sort(), ["absolutePath", "filename", "sha256", "size"]);
    assert.equal(record.actionableFiles[0].absolutePath, uploadPath);
    assert.match(record.actionableFiles[0].sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply-upload consumes before one direct transfer and authorizes only after transfer", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-apply-"));
  try {
    const statePath = join(temp, "tokens.json");
    const uploadPath = join(temp, "ordered.txt");
    await writeFile(uploadPath, "ordered", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const token = "ordered-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");
    const client = directClient({ inventory: [] });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, true);
    assert.equal((await readState(statePath)).tokens[token].consumed, true);
    assert.deepEqual(client.calls, ["list", "prepare-upload", "hidden-input", "list", "plan-upload", "apply-upload"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply-upload transfers immutable verified bytes when the original changes before browser selection", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-snapshot-"));
  try {
    const statePath = join(temp, "tokens.json");
    const uploadPath = join(temp, "immutable.txt");
    await writeFile(uploadPath, "authorized bytes", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const token = "immutable-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");
    let snapshotPath = "";
    let selectedBytes = "";
    const client = directClient({
      inventory: [],
      onBeforeHiddenInput: async () => writeFile(uploadPath, "changed after recheck", "utf8"),
      inspectSelectedFile: async (path) => {
        snapshotPath = path;
        selectedBytes = await readFile(path, "utf8");
      }
    });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, true);
    assert.notEqual(snapshotPath, uploadPath);
    assert.equal(basename(snapshotPath), basename(uploadPath));
    assert.equal(selectedBytes, "authorized bytes");
    assert.equal(await readFile(uploadPath, "utf8"), "changed after recheck");
    await assert.rejects(readFile(snapshotPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the bounded uncertainty cleaner removes a private upload snapshot", { concurrency: false }, async () => {
  const container = await createPrivateSnapshotContainer({ buildTimeoutMs: 60_000 });
  const marker = join(container.directory, "marker.txt");
  const markerBytes = Buffer.from("temporary", "utf8");
  await writeFile(marker, markerBytes);
  if (process.platform !== "win32") await chmod(marker, 0o600);
  const snapshot = await finalizePrivateSnapshot(container, [{
    filename: "marker.txt",
    size: markerBytes.length,
    sha256: createHash("sha256").update(markerBytes).digest("hex")
  }], { transferLeaseMs: 500 });
  try {
    const cleanerPath = fileURLToPath(new URL("../extension/upload-snapshot-cleaner.mjs", import.meta.url));
    const run = await new Promise((resolveRun) => {
      const child = spawn(process.execPath, [cleanerPath, snapshot.directory, snapshot.nonce, String(snapshot.retentionDeadline)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("exit", (code) => resolveRun({ code, stderr }));
    });
    assert.equal(run.code, 0, run.stderr);
    await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
  } finally {
    await removePrivateSnapshot(snapshot.directory, {
      rootPath: snapshot.root,
      expectedNonce: snapshot.nonce,
      expectedDeadline: snapshot.retentionDeadline
    }).catch(() => {});
  }
});

test("early upload transport loss retains verified bytes past ten minutes and through the browser lifetime", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-retention-"));
  let retainedSnapshot = null;
  try {
    const statePath = join(temp, "tokens.json");
    const uploadPath = join(temp, "long-running.txt");
    await writeFile(uploadPath, "authorized long-running bytes", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const token = "long-running-retention-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");

    let lifetime = null;
    const client = directClient({ inventory: [], terminalFailureCommand: "plan-upload" });
    client.retainUploadSnapshotForTest = async (snapshot, limits) => {
      retainedSnapshot = snapshot;
      lifetime = limits;
    };
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.indeterminate, true);
    assert.ok(retainedSnapshot?.directory);
    assert.equal(await readFile(retainedSnapshot.actionableFiles[0].absolutePath, "utf8"), "authorized long-running bytes");
    assert.deepEqual(lifetime, {
      contentBatchTimeoutMs: uploadLifetime.contentBatchTimeoutMs,
      cliApplyTimeoutMs: uploadLifetime.cliApplyTimeoutMs,
      retentionMs: uploadLifetime.snapshotRetentionMs,
      safetyMarginMs: uploadLifetime.snapshotSafetyMarginMs
    });
    assert.ok(lifetime.contentBatchTimeoutMs < lifetime.cliApplyTimeoutMs);
    assert.ok(lifetime.retentionMs >= lifetime.contentBatchTimeoutMs + lifetime.safetyMarginMs);
    assert.ok(lifetime.retentionMs > 10 * 60 * 1000);

    let fakeNow = retainedSnapshot.retentionDeadline - lifetime.retentionMs;
    const fakeStart = fakeNow;
    let scheduled = 0;
    let releaseDelay;
    let signalScheduled;
    const scheduledReady = new Promise((resolveScheduled) => { signalScheduled = resolveScheduled; });
    const wait = (delayMs) => {
      scheduled = delayMs;
      signalScheduled();
      return new Promise((resolveDelay) => { releaseDelay = resolveDelay; });
    };
    const advance = (deltaMs) => {
      fakeNow += deltaMs;
      if (fakeNow - fakeStart >= scheduled && releaseDelay) {
        const release = releaseDelay;
        releaseDelay = null;
        release();
      }
    };

    const cleanup = cleanSnapshotAtDeadline({
      directory: retainedSnapshot.directory,
      nonce: retainedSnapshot.nonce,
      retentionDeadline: retainedSnapshot.retentionDeadline
    }, { wait, now: () => fakeNow });
    await scheduledReady;
    assert.equal(scheduled, lifetime.retentionMs);
    advance(10 * 60 * 1000 + 1);
    await Promise.resolve();
    assert.equal(await readFile(retainedSnapshot.actionableFiles[0].absolutePath, "utf8"), "authorized long-running bytes");
    advance(retainedSnapshot.retentionDeadline - fakeNow);
    await cleanup;
    await assert.rejects(readFile(retainedSnapshot.actionableFiles[0].absolutePath), (error) => error?.code === "ENOENT");
  } finally {
    if (retainedSnapshot?.directory) await rm(retainedSnapshot.directory, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test("transfer failure before browser-active state gets a fresh retained lifetime", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-transfer-retention-"));
  let retainedSnapshot = null;
  try {
    const firstPath = join(temp, "first-transfer.txt");
    const secondPath = join(temp, "second-transfer.txt");
    await writeFile(firstPath, "first retained bytes", "utf8");
    await writeFile(secondPath, "second retained bytes", "utf8");
    const [first, second] = await inspectUploadFiles([firstPath, secondPath]);
    const record = uploadRecord(first, []);
    record.requestedNames = [first.filename, second.filename];
    record.actionableNames = [first.filename, second.filename];
    record.actionableFiles = [first, second].map(({ absolutePath, filename, size, sha256 }) => ({ absolutePath, filename, size, sha256 }));
    const statePath = join(temp, "tokens.json");
    const token = "pre-browser-active-transfer-failure";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    let selectionCount = 0;
    const fakeNow = Date.now() + 5_000;
    const client = directClient({
      inventory: [],
      inspectSelectedFile: async () => {
        selectionCount += 1;
        if (selectionCount === 2) throw new Error("injected second transfer failure");
      }
    });
    client.snapshotNowForTest = () => fakeNow;
    client.retainUploadSnapshotForTest = async (snapshot) => { retainedSnapshot = snapshot; };

    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.equal(selectionCount, 2);
    assert.ok(retainedSnapshot?.directory);
    assert.equal(retainedSnapshot.metadata.state, "retained");
    assert.equal(retainedSnapshot.retentionDeadline, fakeNow + uploadLifetime.snapshotRetentionMs);
    const inspected = await inspectPrivateSnapshot(retainedSnapshot.directory, { rootPath: retainedSnapshot.root });
    assert.equal(inspected.metadata.state, "retained");
    assert.equal(inspected.metadata.retentionDeadline, retainedSnapshot.retentionDeadline);

    let cleanerNow = fakeNow;
    let scheduled = 0;
    let releaseDelay;
    let signalScheduled;
    const scheduledReady = new Promise((resolveScheduled) => { signalScheduled = resolveScheduled; });
    const cleanup = cleanSnapshotAtDeadline({
      directory: retainedSnapshot.directory,
      nonce: retainedSnapshot.nonce,
      retentionDeadline: retainedSnapshot.retentionDeadline
    }, {
      now: () => cleanerNow,
      wait: (delayMs) => {
        scheduled = delayMs;
        signalScheduled();
        return new Promise((resolveDelay) => { releaseDelay = resolveDelay; });
      }
    });
    await scheduledReady;
    assert.equal(scheduled, uploadLifetime.snapshotRetentionMs);
    cleanerNow += uploadLifetime.snapshotTransferLeaseMs + 1;
    await Promise.resolve();
    assert.equal(await readFile(retainedSnapshot.actionableFiles[0].absolutePath, "utf8"), "first retained bytes");
    assert.equal(await readFile(retainedSnapshot.actionableFiles[1].absolutePath, "utf8"), "second retained bytes");
    cleanerNow = retainedSnapshot.retentionDeadline;
    releaseDelay();
    await cleanup;
    await assert.rejects(readFile(retainedSnapshot.actionableFiles[0].absolutePath), (error) => error?.code === "ENOENT");
  } finally {
    if (retainedSnapshot?.directory) {
      await removePrivateSnapshot(retainedSnapshot.directory, {
        rootPath: retainedSnapshot.root,
        expectedNonce: retainedSnapshot.nonce,
        expectedDeadline: retainedSnapshot.retentionDeadline
      }).catch(() => {});
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply-upload completes as a consumed no-op when every filename is already staged", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-noop-"));
  try {
    const statePath = join(temp, "tokens.json");
    const uploadPath = join(temp, "duplicate.txt");
    await writeFile(uploadPath, "duplicate", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const inventory = [row(file.filename, file.sha256, `${file.size} B`)];
    const client = directClient({ inventory });
    const plan = await createPlan({ command: "plan-upload", operands: [uploadPath], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 }, client, 9);
    assert.deepEqual(plan.actionableNames, []);
    const result = await applyPlan({ command: "apply-upload", operands: [plan.token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, true);
    assert.equal(result.tokenConsumed, true);
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.remaining, []);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(client.calls, ["list", "list"]);
    assert.equal((await readState(statePath)).tokens[plan.token].consumed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("apply-upload sends only actionable names for a mixed new and already-staged plan", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-mixed-"));
  try {
    const statePath = join(temp, "tokens.json");
    const newPath = join(temp, "new.txt");
    const stagedPath = join(temp, "staged.txt");
    await writeFile(newPath, "new", "utf8");
    await writeFile(stagedPath, "staged", "utf8");
    const [, stagedFile] = await inspectUploadFiles([newPath, stagedPath]);
    const inventory = [row(stagedFile.filename, stagedFile.sha256, `${stagedFile.size} B`)];
    const client = directClient({ inventory });
    const plan = await createPlan({ command: "plan-upload", operands: [newPath, stagedPath], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 }, client, 9);
    assert.deepEqual(plan.actionableNames, ["new.txt"]);
    assert.deepEqual(plan.skipped.map((item) => item.name), ["staged.txt"]);
    const result = await applyPlan({ command: "apply-upload", operands: [plan.token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, true);
    assert.deepEqual(result.succeeded, ["new.txt"]);
    const applyCommand = client.bridgeCommands.find((command) => command.command === "apply-upload");
    assert.deepEqual(applyCommand.names, ["new.txt"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("upload transfer failure and inventory drift are indeterminate, consumed, and not authorized", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-uncertain-"));
  try {
    const uploadPath = join(temp, "uncertain.txt");
    await writeFile(uploadPath, "uncertain", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    for (const scenario of [
      { name: "transfer", client: directClient({ inventory: [row(file.filename, file.sha256, `${file.size} B`)], failureAtHiddenInput: true }) },
      { name: "drift", client: directClient({ inventory: [], afterTransferInventory: [row(file.filename, file.sha256, `${file.size} B`)] }) }
    ]) {
      const statePath = join(temp, `${scenario.name}.json`);
      const token = `${scenario.name}-token`;
      const inventory = scenario.name === "transfer" ? [row(file.filename, file.sha256, `${file.size} B`)] : [];
      await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, inventory) } }), "utf8");
      const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, scenario.client, 9);
      assert.equal(result.ok, false);
      assert.equal(result.indeterminate, true);
      assert.equal(result.tokenConsumed, true);
      assert.deepEqual(result.succeeded, []);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.uploadedBeforeFailure, [file.filename]);
      assert.equal((await readState(statePath)).tokens[token].consumed, true);
      assert.equal(scenario.client.calls.includes("plan-upload"), false);
      assert.equal(scenario.client.calls.includes("apply-upload"), false);
      assert.equal(scenario.client.retainedSnapshots.length, 1);
      assert.equal(scenario.client.retainedSnapshots[0][0].sha256, file.sha256);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("terminal extension failure after upload transfer is indeterminate and is not retried", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-terminal-"));
  try {
    const uploadPath = join(temp, "terminal.txt");
    await writeFile(uploadPath, "terminal", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const statePath = join(temp, "tokens.json");
    const token = "terminal-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");
    const client = directClient({ inventory: [], terminalFailureCommand: "plan-upload" });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.deepEqual(result.uploadedBeforeFailure, []);
    assert.match(result.error, /No retry was attempted/u);
    assert.equal(client.calls.filter((command) => command === "plan-upload").length, 1);
    assert.equal(client.calls.includes("apply-upload"), false);
    assert.equal((await readState(statePath)).tokens[token].consumed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a stopped upload with remaining files is a certain operation failure", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-stopped-"));
  try {
    const firstPath = join(temp, "first.txt");
    const secondPath = join(temp, "second.txt");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");
    const [first, second] = await inspectUploadFiles([firstPath, secondPath]);
    const record = uploadRecord(first, []);
    record.requestedNames = [first.filename, second.filename];
    record.actionableNames = [first.filename, second.filename];
    record.actionableFiles = [first, second].map(({ absolutePath, filename, size, sha256 }) => ({ absolutePath, filename, size, sha256 }));
    const statePath = join(temp, "tokens.json");
    const token = "stopped-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    const client = directClient({
      inventory: [],
      applyUploadResult: {
        operation: "upload",
        stopped: true,
        uploadSelectionReleased: true,
        succeeded: [first.filename],
        skipped: [],
        failed: [],
        remaining: [second.filename]
      }
    });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.notEqual(result.indeterminate, true);
    assert.deepEqual(result.succeeded, [first.filename]);
    assert.deepEqual(result.remaining, [second.filename]);
    assert.deepEqual(client.retainedSnapshots, []);
    const classified = classifyCommandResult("apply-upload", "TAB-TEST", result);
    assert.equal(classified.exitCode, 4);
    assert.equal(classified.output.ok, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a stopped upload without page selection release proof stays indeterminate and retained", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-stopped-unproved-"));
  try {
    const firstPath = join(temp, "first.txt");
    const secondPath = join(temp, "second.txt");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");
    const [first, second] = await inspectUploadFiles([firstPath, secondPath]);
    const record = uploadRecord(first, []);
    record.requestedNames = [first.filename, second.filename];
    record.actionableNames = [first.filename, second.filename];
    record.actionableFiles = [first, second].map(({ absolutePath, filename, size, sha256 }) => ({ absolutePath, filename, size, sha256 }));
    const statePath = join(temp, "tokens.json");
    const token = "stopped-unproved-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    const client = directClient({
      inventory: [],
      applyUploadResult: {
        operation: "upload",
        stopped: true,
        succeeded: [first.filename],
        skipped: [],
        failed: [],
        remaining: [second.filename]
      }
    });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.equal(client.retainedSnapshots.length, 1);
    assert.deepEqual(result.remaining, [second.filename]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reported upload failure after transfer is indeterminate and reconciles staged inventory", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-reported-failure-"));
  try {
    const uploadPath = join(temp, "reported-failure.txt");
    await writeFile(uploadPath, "reported failure", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const statePath = join(temp, "tokens.json");
    const token = "reported-failure-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");
    const client = directClient({
      inventory: [],
      afterTransferInventory: [],
      afterApplyInventory: [row(file.filename, file.sha256, `${file.size} B`)],
      applyUploadResult: {
        operation: "upload",
        succeeded: [],
        skipped: [],
        failed: [{ name: file.filename, error: "controls did not become stable" }],
        remaining: [file.filename]
      }
    });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.deepEqual(result.failed, [{ name: file.filename, error: "controls did not become stable" }]);
    assert.deepEqual(result.remaining, [file.filename]);
    assert.deepEqual(result.uploadedBeforeFailure, [file.filename]);
    assert.equal(client.calls.filter((command) => command === "apply-upload").length, 1);
    assert.equal((await readState(statePath)).tokens[token].consumed, true);
    const classified = classifyCommandResult("apply-upload", "TAB-TEST", result);
    assert.equal(classified.exitCode, 4);
    assert.equal(classified.output.exitCode, 4);
    assert.equal(classified.output.indeterminate, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("incomplete terminal upload result is indeterminate and supplies safe result arrays", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-incomplete-result-"));
  try {
    const uploadPath = join(temp, "incomplete.txt");
    await writeFile(uploadPath, "incomplete", "utf8");
    const [file] = await inspectUploadFiles([uploadPath]);
    const statePath = join(temp, "tokens.json");
    const token = "incomplete-result-token";
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: uploadRecord(file, []) } }), "utf8");
    const client = directClient({
      inventory: [],
      afterTransferInventory: [],
      afterApplyInventory: [row(file.filename, file.sha256, `${file.size} B`)],
      applyUploadResult: { ok: true, operation: "upload" }
    });
    const result = await applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(result.ok, false);
    assert.equal(result.indeterminate, true);
    assert.equal(result.tokenConsumed, true);
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.remaining, [file.filename]);
    assert.deepEqual(result.uploadedBeforeFailure, [file.filename]);
    assert.match(result.error, /incomplete terminal upload result/u);
    assert.equal(client.calls.filter((command) => command === "apply-upload").length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pre-0.9.6 upload tokens are rejected before transfer", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-old-token-"));
  try {
    const path = join(temp, "old.txt");
    await writeFile(path, "old", "utf8");
    const [file] = await inspectUploadFiles([path]);
    const token = "old-upload-token";
    const record = uploadRecord(file, []);
    delete record.tokenSchemaVersion;
    const statePath = join(temp, "tokens.json");
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    const client = directClient({ inventory: [] });
    await assert.rejects(() => applyPlan({ command: "apply-upload", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9), /predates 0\.9\.6/u);
    assert.deepEqual(client.calls, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("direct apply exceptionDetails after dispatch are indeterminate for every apply operation", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-direct-apply-exception-"));
  try {
    const uploadPath = join(temp, "dispatched.txt");
    await writeFile(uploadPath, "dispatched", "utf8");
    const [uploadFile] = await inspectUploadFiles([uploadPath]);
    const staged = row("staged.txt", "e".repeat(64), "8 B");
    for (const operation of ["upload", "download", "delete"]) {
      const token = `${operation}-exception-token`;
      const statePath = join(temp, `${operation}.json`);
      const record = operation === "upload" ? uploadRecord(uploadFile, []) : {
        issueIdentifier: "TAB-TEST",
        operation,
        targetId: "target_7",
        targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
        targetTitle: "TAB-TEST local fixture",
        connectionMode: "direct",
        bridgeDocumentId: "",
        requestedNames: [staged.filename],
        actionableNames: [staged.filename],
        actionableFiles: [staged],
        skipped: [],
        bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        inventory: [staged],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        consumed: false
      };
      await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
      const client = directClient({
        inventory: operation === "upload" ? [] : [staged],
        exceptionDetailsCommand: `apply-${operation}`
      });
      const result = await applyPlan({ command: `apply-${operation}`, operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
      assert.equal(result.ok, false, operation);
      assert.equal(result.indeterminate, true, operation);
      assert.equal(result.tokenConsumed, true, operation);
      assert.deepEqual(result.succeeded, [], operation);
      assert.equal(result.remaining.length, 1, operation);
      assert.equal(client.calls.filter((name) => name === `apply-${operation}`).length, 1, operation);
      assert.equal((await readState(statePath)).tokens[token].consumed, true, operation);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("parallel processes can dispatch one use of the same apply token at most once", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-token-apply-race-"));
  try {
    const statePath = join(temp, "tokens.json");
    const eventPath = join(temp, "dispatches.txt");
    const releasePath = join(temp, "release.txt");
    const readyPaths = [join(temp, "ready-a.txt"), join(temp, "ready-b.txt")];
    const token = "shared-delete-token";
    const staged = row("race.txt", "f".repeat(64), "4 B");
    const record = {
      issueIdentifier: "TAB-TEST",
      operation: "delete",
      targetId: "target_7",
      targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
      targetTitle: "TAB-TEST local fixture",
      connectionMode: "direct",
      bridgeDocumentId: "",
      requestedNames: [staged.filename],
      actionableNames: [staged.filename],
      actionableFiles: [staged],
      skipped: [],
      bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      inventory: [staged],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      consumed: false
    };
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    const workers = ["a", "b"].map((workerId, index) => runRaceWorker([
      "apply-delete", statePath, eventPath, token, workerId, readyPaths[index], releasePath
    ]));
    await releaseRaceWhenReady(readyPaths, releasePath);
    const runs = await Promise.all(workers);
    const results = runs.map((run) => JSON.parse(run.stdout.trim()));
    const dispatches = await readFile(eventPath, "utf8").then((text) => text.trim().split(/\r?\n/u).filter(Boolean)).catch(() => []);
    assert.equal(dispatches.length, 1, runs.map((run) => run.stderr).join("\n"));
    assert.equal(results.filter((result) => result.ok).length, 1);
    for (const failed of results.filter((result) => !result.ok)) {
      assert.match(failed.error, /lock|already used|changed before it could be claimed/u);
    }
    assert.equal((await readState(statePath)).tokens[token].consumed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("parallel plan creation cannot silently lose a saved token", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-token-plan-race-"));
  try {
    const statePath = join(temp, "tokens.json");
    const eventPath = join(temp, "unused-events.txt");
    const releasePath = join(temp, "release.txt");
    const readyPaths = [join(temp, "ready-a.txt"), join(temp, "ready-b.txt")];
    const workers = ["a", "b"].map((workerId, index) => runRaceWorker([
      "plan-delete", statePath, eventPath, "unused", workerId, readyPaths[index], releasePath
    ]));
    await releaseRaceWhenReady(readyPaths, releasePath);
    const runs = await Promise.all(workers);
    const results = runs.map((run) => JSON.parse(run.stdout.trim()));
    const savedState = await readState(statePath);
    const successfulTokens = results.filter((result) => result.ok).map((result) => result.result.token);
    assert.ok(successfulTokens.length >= 1);
    assert.equal(new Set(successfulTokens).size, successfulTokens.length);
    for (const token of successfulTokens) assert.ok(savedState.tokens[token], `The successful token ${token} was lost.`);
    assert.equal(Object.keys(savedState.tokens).length, successfulTokens.length);
    for (const failed of results.filter((result) => !result.ok)) assert.match(failed.error, /lock/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("target choices expose only allowed IDs and sanitized titles", () => {
  const matches = [
    { targetId: "safe_1", title: "First issue" },
    { targetId: "safe_2", title: "Second https://foreign.example/path" }
  ];
  assert.equal(selectAllowedTarget(matches, "safe_2", "targetId").targetId, "safe_2");
  assert.throws(
    () => selectAllowedTarget(matches, "", "targetId"),
    (error) => /More than one/u.test(error.message) && /safe_1/u.test(error.message) && !/foreign\.example/u.test(error.message)
  );
  assert.equal(parseArguments(["--cdp", "http://127.0.0.1:9222", "--issue", "TAB-TEST", "--target-id", "safe_2", "status"]).targetId, "safe_2");
});

test("plan-delete writes exact filename and hash evidence into its local token", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-delete-evidence-"));
  try {
    const statePath = join(temp, "tokens.json");
    const staged = row("evidence.txt", "c".repeat(64), "8 B");
    const client = directClient({ inventory: [staged] });
    client.request = async (method, params) => {
      assert.equal(method, "Runtime.callFunctionOn");
      const command = params.arguments[0].value;
      client.calls.push(command.command);
      if (command.command === "plan-delete") return { result: { value: { ok: true, operation: "delete", requestedNames: [staged.filename], actionableNames: [staged.filename], skipped: [], inventory: [staged], authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } } };
      if (command.command === "list") return { result: { value: { ok: true, inventory: [staged] } } };
      if (command.command === "apply-delete") return { result: { value: { ok: true, operation: "delete", succeeded: [staged.filename], skipped: [], failed: [], remaining: [] } } };
      throw new Error(`unexpected bridge command ${command.command}`);
    };
    const result = await createPlan({ command: "plan-delete", operands: [staged.filename], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 }, client, 9);
    assert.deepEqual(result.actionableFiles, [staged]);
    assert.deepEqual((await readState(statePath)).tokens[result.token].actionableFiles, [staged]);
    const applied = await applyPlan({ command: "apply-delete", operands: [result.token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.deepEqual(applied.actionableFiles, [staged]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("delete observation failure preserves terminal arrays and a consumed CLI token", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-delete-observation-"));
  try {
    const statePath = join(temp, "tokens.json");
    const staged = row("observed.txt", "d".repeat(64), "8 B");
    const client = directClient({ inventory: [staged] });
    client.request = async (method, params) => {
      assert.equal(method, "Runtime.callFunctionOn");
      const command = params.arguments[0].value;
      client.calls.push(command.command);
      if (command.command === "plan-delete") return { result: { value: {
        ok: true,
        operation: "delete",
        requestedNames: [staged.filename],
        actionableNames: [staged.filename],
        skipped: [],
        inventory: [staged],
        authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
      } } };
      if (command.command === "list") return { result: { value: { ok: true, inventory: [staged] } } };
      if (command.command === "apply-delete") return { result: { value: {
        ok: false,
        operation: "delete",
        succeeded: [staged.filename],
        skipped: [],
        failed: [],
        remaining: [],
        inventoryBefore: [staged],
        inventoryAfter: null,
        inventory: null,
        inventoryObservationError: "The inventory observer failed.",
        needsReadOnlyList: true,
        replayAllowed: false
      } } };
      throw new Error(`unexpected bridge command ${command.command}`);
    };
    const plan = await createPlan({ command: "plan-delete", operands: [staged.filename], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 }, client, 9);
    const applied = await applyPlan({ command: "apply-delete", operands: [plan.token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(applied.ok, false);
    assert.equal(applied.tokenConsumed, true);
    assert.deepEqual(applied.succeeded, [staged.filename]);
    assert.equal(applied.inventoryAfter, null);
    assert.equal(applied.inventory, null);
    assert.equal(applied.needsReadOnlyList, true);
    assert.equal(applied.replayAllowed, false);
    assert.equal((await readState(statePath)).tokens[plan.token].consumed, true);
    assert.equal(classifyCommandResult("apply-delete", "TAB-TEST", applied).exitCode, 4);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unexpected delete rejection stays indeterminate with terminal arrays and a consumed CLI token", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-delete-rejection-"));
  try {
    const statePath = join(temp, "tokens.json");
    const token = "unexpected-delete-rejection-token";
    const staged = row("uncertain-delete.txt", "e".repeat(64), "9 B");
    const now = Date.now();
    const record = {
      issueIdentifier: "TAB-TEST",
      operation: "delete",
      targetId: "target_7",
      targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
      targetTitle: "TAB-TEST local fixture",
      connectionMode: "direct",
      bridgeDocumentId: "",
      requestedNames: [staged.filename],
      actionableNames: [staged.filename],
      actionableFiles: [staged],
      skipped: [],
      bridgeAuthorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      inventory: [staged],
      issuedAt: now,
      expiresAt: now + 60_000,
      consumed: false
    };
    await writeFile(statePath, JSON.stringify({ version: 1, tokens: { [token]: record } }), "utf8");
    const client = directClient({ inventory: [staged] });
    client.request = async (method, params) => {
      assert.equal(method, "Runtime.callFunctionOn");
      const command = params.arguments[0].value;
      client.calls.push(command.command);
      if (command.command === "list") return { result: { value: { ok: true, inventory: [staged] } } };
      if (command.command === "apply-delete") return { result: { value: {
        ok: false,
        operation: "delete",
        succeeded: [],
        skipped: [],
        failed: [{ name: staged.filename, error: "unexpected rejection" }],
        remaining: [staged.filename],
        inventoryBefore: [staged],
        inventoryAfter: [],
        inventory: [],
        indeterminate: true,
        error: "The delete mutation state is uncertain.",
        needsReadOnlyList: true,
        replayAllowed: false
      } } };
      throw new Error(`unexpected bridge command ${command.command}`);
    };
    const applied = await applyPlan({ command: "apply-delete", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9);
    assert.equal(applied.ok, false);
    assert.equal(applied.indeterminate, true);
    assert.equal(applied.tokenConsumed, true);
    assert.deepEqual(applied.failed, [{ name: staged.filename, error: "unexpected rejection" }]);
    assert.deepEqual(applied.remaining, [staged.filename]);
    assert.deepEqual(applied.inventoryBefore, [staged]);
    assert.deepEqual(applied.inventoryAfter, []);
    assert.deepEqual(applied.inventory, []);
    assert.equal(applied.needsReadOnlyList, true);
    assert.equal(applied.replayAllowed, false);
    assert.equal((await readState(statePath)).tokens[token].consumed, true);
    assert.equal(classifyCommandResult("apply-delete", "TAB-TEST", applied).exitCode, 4);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("verify reports all four classifications without bridge mutations", { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-upload-verify-"));
  try {
    const matchedPath = join(temp, "matched.txt");
    const mismatchPath = join(temp, "mismatch.txt");
    const remoteMissingPath = join(temp, "remote-missing.txt");
    await Promise.all([writeFile(matchedPath, "match"), writeFile(mismatchPath, "local"), writeFile(remoteMissingPath, "remote")]);
    const [matched, mismatch] = await inspectUploadFiles([matchedPath, mismatchPath]);
    const client = directClient({ inventory: [
      row(matched.filename, matched.sha256, `${matched.size} B`),
      row(mismatch.filename, "f".repeat(64), `${mismatch.size} B`),
      row("missing-local.txt", "e".repeat(64), "1 B")
    ] });
    const result = await verifyFiles({ operands: [matchedPath, mismatchPath, remoteMissingPath] }, client, 9);
    assert.equal(result.ok, false);
    assert.deepEqual(result.matched.map((item) => item.filename), [basename(matchedPath)]);
    assert.deepEqual(result.mismatched.map((item) => item.filename), [basename(mismatchPath)]);
    assert.deepEqual(result.missingRemotely.map((item) => item.filename), [basename(remoteMissingPath)]);
    assert.deepEqual(result.missingLocally.map((item) => item.filename), ["missing-local.txt"]);
    assert.deepEqual(client.calls, ["list"]);
    const ambiguousClient = directClient({ inventory: [
      row(matched.filename, matched.sha256, `${matched.size} B`),
      row(matched.filename, "d".repeat(64), `${matched.size} B`)
    ] });
    const ambiguous = await verifyFiles({ operands: [matchedPath] }, ambiguousClient, 9);
    assert.equal(ambiguous.ok, false);
    assert.deepEqual(ambiguous.matched, []);
    assert.equal(ambiguous.mismatched[0].reason, "ambiguous staged rows");
    const duplicateClient = directClient({ inventory: [] });
    await assert.rejects(
      () => verifyFiles({ operands: [matchedPath, matchedPath] }, duplicateClient, 9),
      /unique local basenames/u
    );
    assert.deepEqual(duplicateClient.calls, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("bridge recovery uses stable kinds and reserves daemon start advice for confirmed absence", () => {
  const unknownRpc = new Error("The persistent Chrome proxy rejected the request (-32603): unknown.");
  unknownRpc.rpcCode = -32603;
  unknownRpc.rpcMessage = "unknown";
  unknownRpc.data = { note: "safe", secretToken: "private", commandLine: "node proxy --token private", pageData: "private-page-data" };
  const mappedRpc = daemonRecoveryError(unknownRpc, "C:\\safe\\proxy.mjs");
  assert.equal(mappedRpc.errorKind, "rpc_error");
  assert.doesNotMatch(mappedRpc.message, /start-daemon\.ps1/u);
  assert.deepEqual(bridgeErrorOutput(mappedRpc), {
    errorKind: "rpc_error",
    rpcCode: -32603,
    rpcMessage: "unknown",
    errorData: { note: "safe", secretToken: "[redacted]", commandLine: "[redacted]", pageData: "[redacted]" }
  });

  const absent = new Error("The daemon named pipe is absent.");
  absent.status = "daemon_absent";
  const mappedAbsent = daemonRecoveryError(absent, "C:\\safe\\runtime\\stdio-proxy.mjs");
  assert.equal(mappedAbsent.errorKind, "daemon_absent");
  assert.match(mappedAbsent.message, /safe[\\/]runtime[\\/]status\.ps1/u);
  assert.match(mappedAbsent.message, /safe[\\/]runtime[\\/]start-daemon\.ps1/u);
  assert.doesNotMatch(mappedAbsent.message, /runtime[\\/]runtime/u);

  const lease = new Error("The browser transport lease is in use.");
  lease.status = "lease_busy";
  const mappedLease = daemonRecoveryError(lease, "C:\\safe\\runtime\\stdio-proxy.mjs");
  assert.equal(mappedLease.errorKind, "lease_busy");
  assert.equal(mappedLease.leaseOwner, "unknown");
  assert.doesNotMatch(mappedLease.message, /start-daemon\.ps1/u);

  const knownLease = new Error("unsafe command line: node proxy --token private");
  knownLease.status = "lease_busy";
  knownLease.data = { status: "lease_busy", owner_pid: 4321, commandLine: "node proxy --token private", pageData: "private-page-data" };
  const mappedKnownLease = daemonRecoveryError(knownLease, "C:\\safe\\runtime\\stdio-proxy.mjs");
  assert.deepEqual(mappedKnownLease.leaseOwner, { owner_pid: 4321 });
  assert.match(mappedKnownLease.message, /owner PID is 4321/u);
  assert.deepEqual(bridgeErrorOutput(mappedKnownLease).leaseOwner, { owner_pid: 4321 });
  assert.doesNotMatch(JSON.stringify(bridgeErrorOutput(mappedKnownLease)), /node proxy|private-page-data/u);

  const heldUnknown = new Error("held");
  heldUnknown.status = "held_unknown";
  heldUnknown.data = { status: "held_unknown", owner_pid: 9876 };
  const mappedHeldUnknown = daemonRecoveryError(heldUnknown, "C:\\safe\\runtime\\stdio-proxy.mjs");
  assert.equal(mappedHeldUnknown.errorKind, "lease_busy");
  assert.equal(mappedHeldUnknown.leaseOwner, "unknown");
  assert.equal(Object.prototype.hasOwnProperty.call(bridgeErrorOutput(mappedHeldUnknown).errorData, "owner_pid"), false);

  const timeout = new Error("The persistent Chrome proxy timed out during tools/call.");
  timeout.timeout = true;
  assert.equal(daemonRecoveryError(timeout, "C:\\safe\\runtime\\stdio-proxy.mjs").errorKind, "daemon_timeout");

  const lifecycle = new Error("The persistent Chrome proxy session closed.");
  lifecycle.status = "proxy_lifecycle";
  assert.equal(daemonRecoveryError(lifecycle, "C:\\safe\\runtime\\stdio-proxy.mjs").errorKind, "proxy_lifecycle");

  const uncertain = new Error("The persistent Chrome proxy timed out after dispatch.");
  uncertain.indeterminate = true;
  const mappedUncertain = daemonRecoveryError(uncertain, "C:\\safe\\runtime\\stdio-proxy.mjs");
  assert.equal(mappedUncertain, uncertain);
  assert.equal(mappedUncertain.errorKind, "daemon_timeout");
  assert.doesNotMatch(mappedUncertain.message, /retry|kill|restart/iu);
});

test("no matching tab says transport responded and no mutation started", () => {
  assert.throws(
    () => selectAllowedTarget([], "", "targetId"),
    (error) => error.errorKind === "no_matching_tab"
      && error.exitCode === 3
      && /transport responded/u.test(error.message)
      && /required allowed issue tab is not open/u.test(error.message)
      && /No mutation started/u.test(error.message)
  );
});
