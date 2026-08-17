#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const extensionRoot = join(root, "extension");
const serverPath = join(root, "tests", "mock", "server.py");
const fixtureOrigin = "http://127.0.0.1:8769";
const fixtureUrl = `${fixtureOrigin}/issue/TAB-TEST`;
const tempBase = resolve(tmpdir());

function assertTemporaryPath(path) {
  const target = resolve(path);
  if (target === tempBase || !target.startsWith(`${tempBase}${sep}`)) throw new Error(`Refusing to remove a path outside the temporary directory: ${target}`);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`The delete observation test hook was not found: ${label}.`);
  return source.replace(search, replacement);
}

async function prepareTestExtension(buildRoot) {
  await cp(extensionRoot, buildRoot, { recursive: true });
  const manifestPath = join(buildRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = `${manifest.name} - local delete observation integration`;
  manifest.host_permissions = [`${fixtureOrigin}/*`];
  manifest.content_scripts = manifest.content_scripts.map((script) => ({ ...script, matches: [`${fixtureOrigin}/issue/*`] }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const storePath = join(buildRoot, "bridge-plan-store.js");
  const store = await readFile(storePath, "utf8");
  await writeFile(storePath, replaceRequired(
    store,
    "      if (JSON.stringify(plan.inventory) !== JSON.stringify(getInventory())) {",
    "      if (document.body.dataset.tealTestBypassPlanInventory !== \"1\" && JSON.stringify(plan.inventory) !== JSON.stringify(getInventory())) {",
    "missing-panel plan-store bypass"
  ), "utf8");

  const contentPath = join(buildRoot, "content.js");
  let content = (await readFile(contentPath, "utf8")).replace(/\r\n/gu, "\n");
  content = replaceRequired(content, "  const DELETE_GRACE_PERIOD_SECONDS = 5;", "  const DELETE_GRACE_PERIOD_SECONDS = 0;", "delete grace period");
  content = replaceRequired(
    content,
    "  async function startDelete(options = {}) {",
    `  async function startDelete(options = {}) {
    document.body.dataset.tealTestStartDeleteCalls = String(Number(document.body.dataset.tealTestStartDeleteCalls || "0") + 1);
    if (document.body.dataset.tealTestChangeRowAtStartDelete === "1") {
      [...document.querySelectorAll(".staged tbody tr")]
        .find((row) => row.querySelector("td:first-child")?.textContent?.trim() === options.rows?.[0]?.filename)
        ?.remove();
    }`,
    "startDelete counter"
  );
  content = replaceRequired(
    content,
    `      return {
        operation: "delete",
        succeeded: selected.slice(0, completed).map((row) => row.filename),`,
    `      if (document.body.dataset.tealTestLosePanelAfterMutation === "1") document.querySelector(".staged")?.remove();
      return {
        operation: "delete",
        succeeded: selected.slice(0, completed).map((row) => row.filename),`,
    "post-mutation panel loss"
  );
  content = replaceRequired(
    content,
    "  function sendNarrowBridgeCommand(value) {",
    `  // TEST-ONLY: relay strict commands through the real isolated content-script path.
  document.addEventListener("teal-delete-test-command", async () => {
    let request = null;
    try { request = JSON.parse(document.body.dataset.tealDeleteTestCommand || "null"); } catch { }
    if (!request || typeof request.id !== "string" || !request.command || typeof request.command !== "object") return;
    let response;
    try {
      response = { id: request.id, testOk: true, result: await executeBridgeCommand({ ...request.command, issueIdentifier }) };
    } catch (error) {
      response = { id: request.id, testOk: false, error: error instanceof Error ? error.message : String(error) };
    }
    document.body.dataset.tealDeleteTestResult = JSON.stringify(response);
    document.dispatchEvent(new Event("teal-delete-test-result"));
  });

  function sendNarrowBridgeCommand(value) {`,
    "test command relay"
  );
  await writeFile(contentPath, content, "utf8");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function assertFixturePortAvailable() {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(8769, "127.0.0.1", resolveListen);
    });
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let cause;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch (error) { cause = error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw cause || new Error(`${url} did not become ready.`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function sendTestCommand(page, command) {
  return page.evaluate(async (value) => {
    const id = `${Date.now()}-${Math.random()}`;
    document.body.dataset.tealDeleteTestCommand = JSON.stringify({ id, command: value });
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        document.removeEventListener("teal-delete-test-result", onResult);
        rejectResponse(new Error("The local delete command timed out."));
      }, 20_000);
      const onResult = () => {
        let parsed = null;
        try { parsed = JSON.parse(document.body.dataset.tealDeleteTestResult || "null"); } catch { }
        if (parsed?.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener("teal-delete-test-result", onResult);
        resolveResponse(parsed);
      };
      document.addEventListener("teal-delete-test-result", onResult);
      document.dispatchEvent(new Event("teal-delete-test-command"));
    });
    if (!response.testOk) throw new Error(response.error || "The local delete command failed.");
    return response.result;
  }, command);
}

async function reloadFixture(page) {
  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#teal-eval-bulk-files-v1-button").waitFor({ state: "attached", timeout: 20_000 });
}

const integrationRoot = await mkdtemp(join(tmpdir(), "teal-delete-observation-browser-"));
assertTemporaryPath(integrationRoot);
const buildRoot = join(integrationRoot, "extension");
const profileRoot = join(integrationRoot, "profile");

let server;
let browserProcess;
let browser;
let serverLog = "";
let browserLog = "";
try {
  await prepareTestExtension(buildRoot);
  await assertFixturePortAvailable();
  server = spawn("python", [serverPath], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, TEAL_MOCK_PORT: "8769" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { serverLog = `${serverLog}${chunk}`.slice(-24_000); });
  await waitForHttp(fixtureUrl);

  const port = await reserveLoopbackPort();
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
  await access(executablePath, fsConstants.X_OK);
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
  browserProcess.stderr.on("data", (chunk) => { browserLog = `${browserLog}${chunk}`.slice(-24_000); });
  await waitForHttp(`${cdpEndpoint}/json/version`);
  browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  const page = context?.pages().find((candidate) => candidate.url() === fixtureUrl);
  if (!page) throw new Error("The temporary Chromium profile did not load TAB-TEST.");
  assert.deepEqual(context.pages().map((candidate) => candidate.url()).filter((url) => /^https?:/u.test(url)), [fixtureUrl]);
  await reloadFixture(page);

  await page.evaluate(() => document.querySelector(".staged tbody")?.replaceChildren());
  const emptyPlan = await sendTestCommand(page, { command: "plan-delete", names: ["missing.txt"] });
  const empty = await sendTestCommand(page, { command: "apply-delete", names: ["missing.txt"], authorizationId: emptyPlan.authorizationId });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.inventoryBefore, []);
  assert.deepEqual(empty.inventoryAfter, []);
  assert.deepEqual(empty.inventory, []);

  await reloadFixture(page);
  const missingPlan = await sendTestCommand(page, { command: "plan-delete", names: ["existing-alpha.txt"] });
  await page.evaluate(() => {
    document.body.dataset.tealTestBypassPlanInventory = "1";
    document.querySelector(".staged")?.remove();
  });
  const missing = await sendTestCommand(page, { command: "apply-delete", names: ["existing-alpha.txt"], authorizationId: missingPlan.authorizationId });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No mutation was started/u);
  assert.equal(missing.inventoryBefore, null);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.tealTestStartDeleteCalls || "0")), 0);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.nativeRemovePromptCalls || "0")), 0);

  await reloadFixture(page);
  const loadingPlan = await sendTestCommand(page, { command: "plan-delete", names: ["existing-alpha.txt"] });
  await page.evaluate(() => {
    document.body.dataset.tealTestBypassPlanInventory = "1";
    const loading = document.createElement("div");
    loading.textContent = "Loading…";
    document.querySelector(".staged")?.append(loading);
  });
  const loading = await sendTestCommand(page, { command: "apply-delete", names: ["existing-alpha.txt"], authorizationId: loadingPlan.authorizationId });
  assert.equal(loading.ok, false);
  assert.match(loading.inventoryObservationError, /still loading/u);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.tealTestStartDeleteCalls || "0")), 0);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.nativeRemovePromptCalls || "0")), 0);

  await reloadFixture(page);
  const rowRacePlan = await sendTestCommand(page, { command: "plan-delete", names: ["existing-alpha.txt"] });
  await page.evaluate(() => { document.body.dataset.tealTestChangeRowAtStartDelete = "1"; });
  const rowRace = await sendTestCommand(page, { command: "apply-delete", names: ["existing-alpha.txt"], authorizationId: rowRacePlan.authorizationId });
  assert.equal(rowRace.ok, false);
  assert.deepEqual(rowRace.succeeded, []);
  assert.deepEqual(rowRace.failed.map((entry) => entry.name), ["existing-alpha.txt"]);
  assert.deepEqual(rowRace.remaining, ["existing-alpha.txt"]);
  assert.deepEqual(rowRace.inventoryBefore, rowRacePlan.inventory);
  assert.equal(rowRace.inventoryAfter.some((row) => row.filename === "existing-alpha.txt"), false);
  assert.deepEqual(rowRace.inventory, rowRace.inventoryAfter);
  assert.equal(rowRace.replayAllowed, false);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.tealTestStartDeleteCalls || "0")), 1);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.nativeRemovePromptCalls || "0")), 0);

  await reloadFixture(page);
  const lossPlan = await sendTestCommand(page, { command: "plan-delete", names: ["existing-alpha.txt"] });
  await page.evaluate(() => { document.body.dataset.tealTestLosePanelAfterMutation = "1"; });
  const loss = await sendTestCommand(page, { command: "apply-delete", names: ["existing-alpha.txt"], authorizationId: lossPlan.authorizationId });
  assert.equal(loss.ok, false);
  assert.equal(loss.indeterminate, true);
  assert.deepEqual(loss.succeeded, ["existing-alpha.txt"]);
  assert.equal(loss.inventoryAfter, null);
  assert.equal(loss.inventory, null);
  assert.equal(loss.replayAllowed, false);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.tealTestStartDeleteCalls || "0")), 1);
  assert.equal(await page.evaluate(() => Number(document.body.dataset.nativeRemovePromptCalls || "0")), 1);
  await assert.rejects(
    sendTestCommand(page, { command: "apply-delete", names: ["existing-alpha.txt"], authorizationId: lossPlan.authorizationId }),
    /not found or was already used/u
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: "TAB-TEST",
    temporaryProfile: true,
    presentEmpty: "observed",
    missingAndLoadingBeforeMutation: "zero-dispatch",
    rowChangeBeforeDispatch: "terminal-failure-with-exact-remaining",
    panelLossAfterMutation: "indeterminate-no-replay"
  })}\n`);
} catch (error) {
  if (serverLog) process.stderr.write(serverLog);
  if (browserLog) process.stderr.write(browserLog);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stopChild(browserProcess);
  await stopChild(server);
  assertTemporaryPath(integrationRoot);
  await rm(integrationRoot, { recursive: true, force: true });
}
