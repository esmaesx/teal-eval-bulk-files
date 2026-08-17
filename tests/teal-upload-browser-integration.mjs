#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const extensionRoot = resolve(root, "extension");
const cliPath = resolve(extensionRoot, "teal-eval-bulk-cli.mjs");
const serverPath = resolve(root, "tests", "mock", "server.py");
const fixtureOrigin = "http://127.0.0.1:8769";
const fixtureUrl = `${fixtureOrigin}/issue/TAB-TEST`;
const tempBase = resolve(tmpdir());

function assertTemporaryPath(path) {
  const target = resolve(path);
  if (target === tempBase || !target.startsWith(`${tempBase}${sep}`)) {
    throw new Error(`Refusing to remove a path outside the temporary directory: ${target}`);
  }
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!Number.isSafeInteger(port) || port < 1) throw new Error("Could not reserve a loopback CDP port.");
  return port;
}

async function assertLoopbackPortAvailable(port) {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`The dedicated TAB-TEST server cannot start because 127.0.0.1:${port} is already in use.`);
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  }
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError || new Error(`${url} did not become ready.`);
}

async function chooseChromium() {
  const candidate = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
  await access(candidate, fsConstants.X_OK);
  return candidate;
}

function appendCapped(current, chunk, max = 24_000) {
  return `${current}${chunk}`.slice(-max);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`The temporary upload observation point was not found: ${label}.`);
  return source.replace(search, replacement);
}

async function prepareTestExtension(buildRoot) {
  await cp(extensionRoot, buildRoot, { recursive: true });
  const manifestPath = join(buildRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = `${manifest.name} - local direct upload integration`;
  manifest.host_permissions = [`${fixtureOrigin}/*`];
  manifest.content_scripts = (manifest.content_scripts || []).map((script) => ({
    ...script,
    matches: [`${fixtureOrigin}/issue/*`]
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const contentPath = join(buildRoot, "content.js");
  const original = await readFile(contentPath, "utf8");
  let instrumented = replaceRequired(
    original,
    "  function prepareBridgeUploadSelection() {",
    `  // TEST-ONLY: expose direct upload command order on the local TAB-TEST DOM.\n  function recordTestUploadStep(step) {\n    const steps = JSON.parse(document.body.dataset.tealTestUploadSteps || "[]");\n    steps.push(step);\n    document.body.dataset.tealTestUploadSteps = JSON.stringify(steps);\n  }\n\n  function prepareBridgeUploadSelection() {\n    recordTestUploadStep("prepare-upload");`,
    "prepare-upload"
  );
  instrumented = replaceRequired(
    instrumented,
    "    if (!bridgeUploadSelectionActive || !files.length) return;",
    `    if (!bridgeUploadSelectionActive || !files.length) return;\n    recordTestUploadStep(\`select-upload:\${files.map((file) => file.name).join(",")}\`);`,
    "upload selection"
  );
  instrumented = replaceRequired(
    instrumented,
    '    if (command.command === "plan-upload") {',
    '    if (command.command === "plan-upload") {\n      recordTestUploadStep("plan-upload");',
    "plan-upload"
  );
  instrumented = replaceRequired(
    instrumented,
    '    if (command.command === "apply-upload") {',
    '    if (command.command === "apply-upload") {\n      recordTestUploadStep("apply-upload");',
    "apply-upload"
  );
  instrumented = replaceRequired(
    instrumented,
    "      const result = await startUpload({ files: plan.files, fromBridge: true });",
    `      // TEST-ONLY: create a loading-to-ready duplicate after authorization consumption.\n      if (document.body.dataset.tealTestReadyDuplicate === "1" && plan.files.length) {\n        const panel = findNativePanel();\n        const table = panel?.container.querySelector("table");\n        if (!panel || !table) throw new Error("The local duplicate-ready fixture was not available.");\n        const loading = document.createElement("div");\n        loading.textContent = "Loading…";\n        table.replaceWith(loading);\n        window.setTimeout(() => {\n          const name = plan.files[0].name;\n          const tr = document.createElement("tr");\n          tr.innerHTML = \`<td>\${name}</td><td>1 B</td><td><span title="\${"f".repeat(64)}">\${"f".repeat(8)}</span></td><td><button type="button">download</button><button class="danger" type="button">remove</button></td>\`;\n          table.querySelector("tbody").appendChild(tr);\n          loading.replaceWith(table);\n        }, 350);\n      }\n      const result = await startUpload({ files: plan.files, fromBridge: true });`,
    "ready duplicate transition"
  );
  instrumented = replaceRequired(
    instrumented,
    "        succeededNames.push(file.name);",
    `        succeededNames.push(file.name);
        if (document.body.dataset.tealTestStopAfterFirst === "1" && completed === 1) stopAfterCurrent = true;`,
    "stop after first upload"
  );
  instrumented = replaceRequired(
    instrumented,
    "          const uploadSelectionReleased = selectedUploads.length === 0",
    `          document.body.dataset.tealTestReleasedUploadReferences = JSON.stringify({
            selectedUploads: selectedUploads.length,
            optionFiles: Array.isArray(options.files) ? options.files.length : -1,
            sourceFiles: sourceFiles.length,
            uploadable: uploadable.length,
            uploadQueue: uploadQueue.length,
            skipped: skipped.length,
            bridgeInputFiles: ui.bridgeUploadInput.files?.length || 0
          });
          const uploadSelectionReleased = selectedUploads.length === 0`,
    "stopped upload reference release"
  );
  await writeFile(contentPath, instrumented, "utf8");
}

async function runProcess(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk, 2 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function parseOnlyJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `CLI stdout was not one JSON line: ${stdout}`);
  return JSON.parse(lines[0]);
}

async function runCli(cdpEndpoint, statePath, args, timeoutMs = 120_000) {
  return runProcess(process.execPath, [
    cliPath,
    "--cdp", cdpEndpoint,
    "--issue", "TAB-TEST",
    "--state", statePath,
    ...args
  ], { timeoutMs });
}

async function observeFixture(page) {
  return page.evaluate(() => ({
    rows: [...document.querySelectorAll(".staged tbody tr")].map((row) => ({
      filename: row.querySelector("td:first-child")?.textContent || "",
      sha256: row.querySelector("td:nth-child(3) span")?.getAttribute("title") || ""
    })),
    nativeUploadInputChanges: Number(document.body.dataset.nativeUploadInputChanges || "0"),
    nativeUploadFinalizations: Number(document.body.dataset.nativeUploadFinalizations || "0"),
    nativeUploadFinalizedNames: JSON.parse(document.body.dataset.nativeUploadFinalizedNames || "[]"),
    releasedUploadReferences: JSON.parse(document.body.dataset.tealTestReleasedUploadReferences || "null"),
    uploadSteps: JSON.parse(document.body.dataset.tealTestUploadSteps || "[]"),
    externalResources: performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /^https?:/iu.test(url) && !url.startsWith("http://127.0.0.1:8769/"))
  }));
}

async function setStagedPanelState(page, state) {
  await page.evaluate((nextState) => {
    const saved = window.__tealInventoryFixture ||= {};
    if (nextState === "ready") {
      if (saved.panel && !saved.panel.isConnected) saved.parent.insertBefore(saved.panel, saved.nextSibling);
      if (saved.loading?.isConnected && saved.table) saved.loading.replaceWith(saved.table);
      if (saved.rows?.length) saved.rows.forEach((row) => saved.tbody.appendChild(row));
      window.__tealInventoryFixture = {};
      return;
    }
    const panel = document.querySelector(".staged");
    if (!panel) throw new Error("The local staged panel was absent before fixture setup.");
    if (nextState === "missing") {
      saved.panel = panel;
      saved.parent = panel.parentNode;
      saved.nextSibling = panel.nextSibling;
      panel.remove();
      return;
    }
    const table = panel.querySelector("table");
    if (!table) throw new Error("The local staged table was absent before fixture setup.");
    if (nextState === "loading") {
      const loading = document.createElement("div");
      loading.textContent = "Loading…";
      saved.table = table;
      saved.loading = loading;
      table.replaceWith(loading);
      return;
    }
    if (nextState === "empty") {
      const tbody = table.querySelector("tbody");
      saved.tbody = tbody;
      saved.rows = [...tbody.children];
      saved.rows.forEach((row) => row.remove());
      return;
    }
    throw new Error(`Unsupported staged panel fixture state: ${nextState}`);
  }, state);
}

async function assertInventoryUnavailable(cdpEndpoint, statePath, args, expected) {
  const run = await runCli(cdpEndpoint, statePath, args);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0, `${args.join(" ")} unexpectedly succeeded`);
  const output = parseOnlyJson(run.stdout);
  assert.equal(output.ok, false);
  assert.match(output.error, expected);
  return output;
}

const integrationRoot = await mkdtemp(join(tmpdir(), "teal-upload-browser-integration-"));
assertTemporaryPath(integrationRoot);
const buildRoot = join(integrationRoot, "extension");
const profileRoot = join(integrationRoot, "profile");
const statePath = join(integrationRoot, "tokens.json");
const uploadPath = join(integrationRoot, "direct-upload-regression.txt");
const emptyPlanUploadPath = join(integrationRoot, "present-empty-plan.txt");
const readyDuplicateUploadPath = join(integrationRoot, "ready-duplicate.txt");
const stoppedFirstUploadPath = join(integrationRoot, "stopped-first.txt");
const stoppedSecondUploadPath = join(integrationRoot, "stopped-second.txt");
const snapshotRoot = join(tmpdir(), "teal-eval-bulk-files-private-v1");
const uploadBytes = Buffer.from("local direct upload regression\n", "utf8");
const uploadSha256 = createHash("sha256").update(uploadBytes).digest("hex");
await writeFile(uploadPath, uploadBytes);
await writeFile(emptyPlanUploadPath, "present empty plan\n", "utf8");
await writeFile(readyDuplicateUploadPath, "must not dispatch\n", "utf8");
await writeFile(stoppedFirstUploadPath, "stopped first\n", "utf8");
await writeFile(stoppedSecondUploadPath, "stopped second\n", "utf8");
await prepareTestExtension(buildRoot);

let server;
let serverLog = "";

let browserProcess;
let browser;
let browserLog = "";
try {
  await assertLoopbackPortAvailable(8769);
  server = spawn("python", [serverPath], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, TEAL_MOCK_PORT: "8769" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { serverLog = appendCapped(serverLog, chunk); });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  if (server.exitCode !== null || server.signalCode !== null) {
    throw new Error(`The dedicated TAB-TEST server did not start. Port 8769 can be in use.\n${serverLog}`);
  }
  await waitForHttp(fixtureUrl, 15_000);

  const port = await reserveLoopbackPort();
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const executablePath = await chooseChromium();
  browserProcess = spawn(executablePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    `--disable-extensions-except=${buildRoot}`,
    `--load-extension=${buildRoot}`,
    "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileRoot}`,
    fixtureUrl
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  browserProcess.stderr.setEncoding("utf8");
  browserProcess.stderr.on("data", (chunk) => { browserLog = appendCapped(browserLog, chunk); });

  await waitForHttp(`${cdpEndpoint}/json/version`, 20_000);
  browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chromium exposed no browser context over loopback CDP.");
  const page = context.pages().find((candidate) => candidate.url() === fixtureUrl);
  if (!page) throw new Error(`The dedicated Chromium process did not load only ${fixtureUrl}.\n${browserLog}`);
  await page.locator("#teal-eval-bulk-files-v1-button").waitFor({ state: "attached", timeout: 20_000 });
  const loadedHttpPages = context.pages().map((candidate) => candidate.url()).filter((url) => /^https?:/iu.test(url));
  assert.deepEqual(loadedHttpPages, [fixtureUrl], "the dedicated browser must load only the local TAB-TEST HTTP page");

  const initialListRun = await runCli(cdpEndpoint, statePath, ["list"]);
  assert.equal(initialListRun.timedOut, false);
  assert.equal(initialListRun.code, 0, `${initialListRun.stderr}\n${browserLog}`);
  const initialList = parseOnlyJson(initialListRun.stdout);

  for (const [panelState, expectedError] of [["missing", /staged-files panel.*not present/iu], ["loading", /staged-files panel.*loading/iu]]) {
    await setStagedPanelState(page, panelState);
    try {
      await assertInventoryUnavailable(cdpEndpoint, statePath, ["list"], expectedError);
      await assertInventoryUnavailable(cdpEndpoint, statePath, ["plan-upload", emptyPlanUploadPath], expectedError);
      await assertInventoryUnavailable(cdpEndpoint, statePath, ["plan-delete", "existing-alpha.txt"], expectedError);
      await assertInventoryUnavailable(cdpEndpoint, statePath, ["plan-download", "existing-alpha.txt"], expectedError);
      await assertInventoryUnavailable(cdpEndpoint, statePath, ["verify", emptyPlanUploadPath], expectedError);
    } finally {
      await setStagedPanelState(page, "ready");
    }
  }

  await setStagedPanelState(page, "empty");
  try {
    const emptyListRun = await runCli(cdpEndpoint, statePath, ["list"]);
    assert.equal(emptyListRun.code, 0, emptyListRun.stderr);
    assert.deepEqual(parseOnlyJson(emptyListRun.stdout).inventory, []);

    const emptyDeleteRun = await runCli(cdpEndpoint, statePath, ["plan-delete", "existing-alpha.txt"]);
    assert.equal(emptyDeleteRun.code, 0, emptyDeleteRun.stderr);
    const emptyDelete = parseOnlyJson(emptyDeleteRun.stdout);
    assert.deepEqual(emptyDelete.inventory, []);
    assert.deepEqual(emptyDelete.actionableNames, []);

    const emptyDownloadRun = await runCli(cdpEndpoint, statePath, ["plan-download", "existing-alpha.txt"]);
    assert.equal(emptyDownloadRun.code, 0, emptyDownloadRun.stderr);
    const emptyDownload = parseOnlyJson(emptyDownloadRun.stdout);
    assert.deepEqual(emptyDownload.inventory, []);
    assert.deepEqual(emptyDownload.actionableNames, []);

    const emptyUploadRun = await runCli(cdpEndpoint, statePath, ["plan-upload", emptyPlanUploadPath]);
    assert.equal(emptyUploadRun.code, 0, emptyUploadRun.stderr);
    const emptyUpload = parseOnlyJson(emptyUploadRun.stdout);
    assert.deepEqual(emptyUpload.inventory, []);
    assert.deepEqual(emptyUpload.actionableNames, ["present-empty-plan.txt"]);

    const emptyVerifyRun = await runCli(cdpEndpoint, statePath, ["verify", emptyPlanUploadPath]);
    assert.equal(emptyVerifyRun.code, 4, emptyVerifyRun.stderr);
    const emptyVerify = parseOnlyJson(emptyVerifyRun.stdout);
    assert.deepEqual(emptyVerify.missingRemotely.map((file) => file.filename), ["present-empty-plan.txt"]);
  } finally {
    await setStagedPanelState(page, "ready");
  }
  await page.evaluate(() => { document.body.dataset.tealTestUploadSteps = "[]"; });

  const before = await observeFixture(page);
  assert.deepEqual(before.externalResources, [], "the local fixture must not request an external HTTP resource");
  assert.equal(before.nativeUploadInputChanges, 0);
  assert.equal(before.nativeUploadFinalizations, 0);
  assert.deepEqual(before.uploadSteps, []);

  const planRun = await runCli(cdpEndpoint, statePath, ["plan-upload", uploadPath]);
  assert.equal(planRun.timedOut, false);
  assert.equal(planRun.code, 0, `${planRun.stderr}\n${browserLog}`);
  const plan = parseOnlyJson(planRun.stdout);
  assert.deepEqual(plan.actionableNames, ["direct-upload-regression.txt"]);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.actionableFiles, [{
    filename: "direct-upload-regression.txt",
    sha256: uploadSha256,
    sizeText: `${uploadBytes.length} B`
  }]);

  const afterPlanListRun = await runCli(cdpEndpoint, statePath, ["list"]);
  assert.equal(afterPlanListRun.code, 0, afterPlanListRun.stderr);
  const afterPlanList = parseOnlyJson(afterPlanListRun.stdout);
  const afterPlan = await observeFixture(page);
  assert.deepEqual(afterPlanList.inventory, initialList.inventory, "plan-upload must not change staged inventory");
  assert.deepEqual(afterPlan.rows, before.rows, "plan-upload must not add or finalize a staged row");
  assert.equal(afterPlan.nativeUploadInputChanges, 0, "plan-upload must not touch the native Teal upload input");
  assert.equal(afterPlan.nativeUploadFinalizations, 0, "plan-upload must not finalize an upload");
  assert.deepEqual(afterPlan.uploadSteps, [], "plan-upload must not prepare or transfer a browser file selection");

  const applyRun = await runCli(cdpEndpoint, statePath, ["apply-upload", plan.token]);
  assert.equal(applyRun.timedOut, false);
  assert.equal(applyRun.code, 0, `${applyRun.stderr}\n${browserLog}`);
  const applied = parseOnlyJson(applyRun.stdout);
  assert.deepEqual(applied.succeeded, ["direct-upload-regression.txt"]);
  assert.deepEqual(applied.skipped, []);
  assert.deepEqual(applied.failed, []);
  assert.deepEqual(applied.remaining, []);
  assert.equal(applied.token, plan.token);
  assert.equal(applied.tokenConsumed, true);

  const finalListRun = await runCli(cdpEndpoint, statePath, ["list"]);
  assert.equal(finalListRun.code, 0, finalListRun.stderr);
  const finalList = parseOnlyJson(finalListRun.stdout);
  const added = finalList.inventory.filter((row) => row.filename === "direct-upload-regression.txt");
  assert.deepEqual(added, [{
    filename: "direct-upload-regression.txt",
    sha256: uploadSha256,
    sizeText: `${uploadBytes.length} B`
  }]);

  const afterApply = await observeFixture(page);
  assert.equal(afterApply.nativeUploadInputChanges, 1, "apply-upload must set the native input once");
  assert.equal(afterApply.nativeUploadFinalizations, 1, "apply-upload must finalize one file once");
  assert.deepEqual(afterApply.nativeUploadFinalizedNames, ["direct-upload-regression.txt"]);
  assert.deepEqual(afterApply.uploadSteps, [
    "prepare-upload",
    "select-upload:direct-upload-regression.txt",
    "plan-upload",
    "apply-upload"
  ], "direct apply must prepare before selection, authorization, and mutation");
  const tokenState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(tokenState.tokens[plan.token].consumed, true);

  const duplicatePlanRun = await runCli(cdpEndpoint, statePath, ["plan-upload", readyDuplicateUploadPath]);
  assert.equal(duplicatePlanRun.code, 0, duplicatePlanRun.stderr);
  const duplicatePlan = parseOnlyJson(duplicatePlanRun.stdout);
  assert.deepEqual(duplicatePlan.actionableNames, ["ready-duplicate.txt"]);
  const beforeDuplicate = await observeFixture(page);
  await page.evaluate(() => { document.body.dataset.tealTestReadyDuplicate = "1"; });
  const duplicateApplyRun = await runCli(cdpEndpoint, statePath, ["apply-upload", duplicatePlan.token]);
  assert.equal(duplicateApplyRun.timedOut, false);
  assert.equal(duplicateApplyRun.code, 0, `${duplicateApplyRun.stderr}\n${browserLog}`);
  const duplicateApplied = parseOnlyJson(duplicateApplyRun.stdout);
  assert.deepEqual(duplicateApplied.succeeded, []);
  assert.deepEqual(duplicateApplied.failed, []);
  assert.deepEqual(duplicateApplied.remaining, []);
  assert.deepEqual(duplicateApplied.skipped.map((entry) => entry.name), ["ready-duplicate.txt"]);
  assert.match(duplicateApplied.skipped[0].reason, /ready panel|staged while waiting/u);
  assert.equal(duplicateApplied.tokenConsumed, true);
  const afterDuplicate = await observeFixture(page);
  assert.equal(afterDuplicate.nativeUploadInputChanges, beforeDuplicate.nativeUploadInputChanges, "the ready duplicate must not dispatch the native upload input");
  assert.equal(afterDuplicate.nativeUploadFinalizations, beforeDuplicate.nativeUploadFinalizations, "the ready duplicate must not finalize an upload");
  await page.evaluate(() => { document.body.dataset.tealTestReadyDuplicate = "0"; });

  const snapshotChildrenBeforeStop = new Set(await readdir(snapshotRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  }));
  const stoppedPlanRun = await runCli(cdpEndpoint, statePath, ["plan-upload", stoppedFirstUploadPath, stoppedSecondUploadPath]);
  assert.equal(stoppedPlanRun.code, 0, stoppedPlanRun.stderr);
  const stoppedPlan = parseOnlyJson(stoppedPlanRun.stdout);
  assert.deepEqual(stoppedPlan.actionableNames, ["stopped-first.txt", "stopped-second.txt"]);
  const beforeStopped = await observeFixture(page);
  await page.evaluate(() => { document.body.dataset.tealTestStopAfterFirst = "1"; });
  const stoppedApplyRun = await runCli(cdpEndpoint, statePath, ["apply-upload", stoppedPlan.token]);
  assert.equal(stoppedApplyRun.timedOut, false);
  assert.equal(stoppedApplyRun.code, 4, `${stoppedApplyRun.stderr}\n${browserLog}`);
  const stoppedApplied = parseOnlyJson(stoppedApplyRun.stdout);
  assert.equal(stoppedApplied.ok, false);
  assert.equal(stoppedApplied.stopped, true);
  assert.equal(stoppedApplied.uploadSelectionReleased, true);
  assert.notEqual(stoppedApplied.indeterminate, true);
  assert.deepEqual(stoppedApplied.succeeded, ["stopped-first.txt"]);
  assert.deepEqual(stoppedApplied.failed, []);
  assert.deepEqual(stoppedApplied.remaining, ["stopped-second.txt"]);
  const afterStopped = await observeFixture(page);
  assert.equal(afterStopped.nativeUploadInputChanges, beforeStopped.nativeUploadInputChanges + 1, "a stopped two-file apply must dispatch only the first native upload");
  assert.equal(afterStopped.nativeUploadFinalizations, beforeStopped.nativeUploadFinalizations + 1, "a stopped two-file apply must finalize only the first upload");
  assert.deepEqual(afterStopped.releasedUploadReferences, {
    selectedUploads: 0,
    optionFiles: 0,
    sourceFiles: 0,
    uploadable: 0,
    uploadQueue: 0,
    skipped: 0,
    bridgeInputFiles: 0
  });
  const snapshotChildrenAfterStop = await readdir(snapshotRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(snapshotChildrenAfterStop.filter((name) => !snapshotChildrenBeforeStop.has(name)), [], "the stopped result must release page File objects before snapshot removal");
  await page.evaluate(() => { document.body.dataset.tealTestStopAfterFirst = "0"; });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixtureUrl,
    browserProfileWasTemporary: true,
    planWasNonMutating: true,
    applyDispatchCount: 1,
    readyDuplicateUploadDispatchCount: 0,
    stoppedUploadDispatchCount: 1,
    stoppedUploadSelectionReleased: true,
    filename: added[0].filename,
    sha256: added[0].sha256,
    commandOrder: afterApply.uploadSteps
  })}\n`);
} catch (error) {
  if (serverLog) process.stderr.write(serverLog);
  if (browserLog) process.stderr.write(browserLog);
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopChild(browserProcess);
  await stopChild(server);
  assertTemporaryPath(integrationRoot);
  await rm(integrationRoot, { recursive: true, force: true });
}
