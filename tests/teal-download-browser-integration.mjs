#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const extensionRoot = resolve(root, "extension");
const cliPath = resolve(extensionRoot, "teal-eval-bulk-cli.mjs");
const serverPath = resolve(root, "tests", "mock", "server.py");
const fixtureOrigin = "http://127.0.0.1:8769";
const fixtureUrl = `${fixtureOrigin}/issue/TAB-TEST`;
const expectedFiles = new Map([
  ["existing-alpha.txt", Buffer.from("alpha")],
  ["existing-beta.csv", Buffer.from("beta")],
  ["existing-gamma.json", Buffer.from("gamma")],
  ["existing-delta.md", Buffer.from("delta")]
]);
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

async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
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

async function prepareTestExtension(buildRoot, { bypassHeadlessSaveAs, simulateIndeterminateTimeout = false }) {
  await cp(extensionRoot, buildRoot, { recursive: true });
  const manifestPath = join(buildRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = `${manifest.name} - local CLI download integration`;
  manifest.host_permissions = [`${fixtureOrigin}/*`];
  manifest.content_scripts = (manifest.content_scripts || []).map((script) => ({
    ...script,
    matches: [`${fixtureOrigin}/issue/*`]
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const backgroundPath = join(buildRoot, "background.js");
  const original = await readFile(backgroundPath, "utf8");
  let changed = original.replace(
    'const TEAL_ORIGIN = "https://platform-teal-alpha.vercel.app";',
    `const TEAL_ORIGIN = "${fixtureOrigin}";`
  );
  if (changed === original && !/senderIssueContext\(|fetchJson\(origin,/u.test(original)) {
    throw new Error("The temporary extension could not bind its test API origin to TAB-TEST.");
  }
  if (bypassHeadlessSaveAs) {
    const prior = changed;
    changed = changed.replace(
      'chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" }',
      'chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }'
    );
    if (changed === prior) throw new Error("The controlled headless Save As test seam was not found.");
    changed = `// TEST-ONLY: headless Chromium has no visible Save As dialog. Production remains saveAs:true.\n${changed}`;
  }
  if (simulateIndeterminateTimeout) {
    const beforeTerminalSuppression = changed;
    changed = changed.replace(
      /chrome\.downloads\.onChanged\.addListener\(\(delta\) => \{\r?\n\s*if \(delta\.state\?\.current === "complete"[^\r\n]+\r?\n\}\);/u,
      `chrome.downloads.onChanged.addListener((delta) => {\n  void delta; // TEST-ONLY: withhold the terminal event after a started download.\n});`
    );
    changed = changed.replace(
      "  checkTerminalState(downloadId);",
      "  void downloadId; // TEST-ONLY: withhold the terminal search after a started download."
    );
    if (changed === beforeTerminalSuppression || /notifyTerminal\(delta\.|checkTerminalState\(downloadId\);/u.test(changed)) {
      throw new Error("The indeterminate download terminal-suppression seams were not found.");
    }
  }
  await writeFile(backgroundPath, changed, "utf8");

  if (simulateIndeterminateTimeout) {
    const contentPath = join(buildRoot, "content.js");
    const originalContent = await readFile(contentPath, "utf8");
    let testContent = originalContent.replace(
      "const DOWNLOAD_SAVE_AS_TIMEOUT_MS = 2 * 60 * 60 * 1000;",
      "const DOWNLOAD_SAVE_AS_TIMEOUT_MS = 300; // TEST-ONLY"
    );
    testContent = testContent.replace(
      /^(\s*)chrome\.runtime\.sendMessage\(\{\r?\n(\s*)type: SAVE_ZIP_MESSAGE,/mu,
      (_match, commandIndent, fieldIndent) => `${commandIndent}document.body.dataset.tealTestSaveDispatches = String(Number(document.body.dataset.tealTestSaveDispatches || "0") + 1);\n${commandIndent}chrome.runtime.sendMessage({\n${fieldIndent}type: SAVE_ZIP_MESSAGE,`
    );
    testContent = testContent.replace(
      "  function revokeRetainedBlobUrl(blobUrl) {",
      `  function revokeRetainedBlobUrl(blobUrl) {\n    document.body.dataset.tealTestBlobRevoked = "1";`
    );
    testContent = testContent.replace(
      "  function retainIndeterminateBlobUrl(blobUrl) {",
      `  function retainIndeterminateBlobUrl(blobUrl) {\n    document.body.dataset.tealTestBlobPreserved = "1";`
    );
    if (testContent === originalContent || !/tealTestSaveDispatches/u.test(testContent) || !/tealTestBlobPreserved/u.test(testContent)) {
      throw new Error("The indeterminate download content observation seams were not found.");
    }
    await writeFile(contentPath, testContent, "utf8");
  }
}

async function runProcess(command, args, { cwd = root, env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
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

async function runCli(cdpEndpoint, statePath, args, timeoutMs = 60_000) {
  return runProcess(process.execPath, [
    cliPath,
    "--cdp", cdpEndpoint,
    "--issue", "TAB-TEST",
    "--state", statePath,
    ...args
  ], { timeoutMs });
}

async function waitForOneZip(downloadRoot, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(downloadRoot).catch(() => []);
    const zipNames = names.filter((name) => name.toLowerCase().endsWith(".zip"));
    const partialNames = names.filter((name) => name.toLowerCase().endsWith(".crdownload"));
    if (zipNames.length === 1 && partialNames.length === 0) return join(downloadRoot, zipNames[0]);
    if (zipNames.length > 1) throw new Error(`Expected one ZIP download, received ${zipNames.length}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return "";
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("The downloaded file had no ZIP end record.");
}

function readZipEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  let centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("The ZIP central directory was invalid.");
    const flags = buffer.readUInt16LE(centralOffset + 8);
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
    if (flags & 1) throw new Error(`The ZIP entry was unexpectedly encrypted: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`The ZIP local entry was invalid: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`The ZIP entry used unsupported compression method ${method}: ${name}`);
    assert.equal(data.length, uncompressedSize, `ZIP entry size mismatch: ${name}`);
    entries.set(name, data);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function verifyZip(zipPath, applyResult) {
  const archive = await readFile(zipPath);
  const entries = readZipEntries(archive);
  assert.deepEqual([...entries.keys()].sort(), [...expectedFiles.keys()].sort());
  for (const [name, expected] of expectedFiles) assert.deepEqual(entries.get(name), expected, `ZIP bytes changed for ${name}`);
  assert.equal(Number.isInteger(applyResult.downloadId), true);
  return {
    archiveFilename: applyResult.archiveFilename,
    actualFilename: basename(zipPath),
    filenameMatched: basename(zipPath) === applyResult.archiveFilename,
    byteLength: archive.length,
    entryNames: [...entries.keys()].sort()
  };
}

async function runBrowserPhase(phaseRoot, { bypassHeadlessSaveAs, applyTimeoutMs, simulateIndeterminateTimeout = false }) {
  const buildRoot = join(phaseRoot, "extension");
  const profileRoot = join(phaseRoot, "profile");
  const downloadRoot = join(phaseRoot, "downloads");
  const statePath = join(phaseRoot, "tokens.json");
  await mkdir(downloadRoot, { recursive: true });
  await prepareTestExtension(buildRoot, { bypassHeadlessSaveAs, simulateIndeterminateTimeout });

  const port = await reserveLoopbackPort();
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const executablePath = await chooseChromium();
  const browserProcess = spawn(executablePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    `--disable-extensions-except=${buildRoot}`,
    `--load-extension=${buildRoot}`,
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileRoot}`,
    fixtureUrl
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let browserLog = "";
  browserProcess.stderr.setEncoding("utf8");
  browserProcess.stderr.on("data", (chunk) => { browserLog = appendCapped(browserLog, chunk); });

  let browser;
  try {
    await waitForHttp(`${cdpEndpoint}/json/version`, 20_000);
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch (error) {
      throw new Error(`Could not attach Playwright to the dedicated Chromium CDP endpoint: ${error instanceof Error ? error.message : String(error)}\nChromium log:\n${browserLog}`);
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chromium exposed no browser context over loopback CDP.");
    let page = context.pages().find((candidate) => candidate.url() === fixtureUrl);
    if (!page) {
      page = await context.newPage();
      await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    }
    await page.locator("#teal-eval-bulk-files-v1-button").waitFor({ state: "attached", timeout: 20_000 });
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadRoot, eventsEnabled: true });

    const listRun = await runCli(cdpEndpoint, statePath, ["list"]);
    assert.equal(listRun.code, 0, `${listRun.stderr}\n${browserLog}`);
    const listed = parseOnlyJson(listRun.stdout);
    assert.deepEqual(listed.inventory.map((row) => row.filename).sort(), [...expectedFiles.keys()].sort());

    const requested = [...expectedFiles.keys()];
    const planRun = await runCli(cdpEndpoint, statePath, ["plan-download", ...requested]);
    assert.equal(planRun.code, 0, `${planRun.stderr}\n${browserLog}`);
    const plan = parseOnlyJson(planRun.stdout);
    assert.deepEqual(plan.actionableNames, requested);
    assert.deepEqual(plan.skipped, []);

    const applyRun = await runCli(cdpEndpoint, statePath, ["apply-download", plan.token], applyTimeoutMs);
    const zipPath = await waitForOneZip(downloadRoot, applyRun.timedOut ? 1_000 : 15_000);
    if (simulateIndeterminateTimeout) {
      assert.equal(applyRun.timedOut, false, "the extension must return its structured indeterminate result");
      assert.equal(applyRun.code, 4, applyRun.stderr);
      const apply = parseOnlyJson(applyRun.stdout);
      assert.equal(apply.ok, false);
      assert.equal(apply.indeterminate, true);
      assert.equal(apply.tokenConsumed, true);
      assert.equal(Number.isInteger(apply.downloadId), true);
      assert.match(apply.error, /started.*did not report its final state/iu);
      assert.deepEqual(apply.succeeded, []);
      assert.deepEqual(apply.skipped, []);
      assert.deepEqual(apply.failed, [], "an uncertain started download is not a confirmed failure");
      assert.deepEqual(apply.remaining, requested, "all requested selections remain available after uncertainty");
      assert.ok(zipPath, "the browser must receive exactly one started ZIP dispatch");
      const verified = await verifyZip(zipPath, apply);
      const tokenState = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(tokenState.tokens[plan.token].consumed, true);
      const observed = await page.evaluate(() => ({
        dispatches: document.body.dataset.tealTestSaveDispatches || "0",
        blobRevoked: document.body.dataset.tealTestBlobRevoked || "0",
        blobPreserved: document.body.dataset.tealTestBlobPreserved || "0"
      }));
      assert.deepEqual(observed, { dispatches: "1", blobRevoked: "0", blobPreserved: "1" });
      const secondApply = await runCli(cdpEndpoint, statePath, ["apply-download", plan.token]);
      assert.equal(secondApply.code, 4);
      assert.match(parseOnlyJson(secondApply.stdout).error, /already used/u);
      const zipNames = (await readdir(downloadRoot)).filter((name) => name.toLowerCase().endsWith(".zip"));
      assert.equal(zipNames.length, 1, "the consumed token must not dispatch a second ZIP");
      assert.equal((await page.evaluate(() => document.body.dataset.tealTestSaveDispatches || "0")), "1");
      return { completed: true, verified, downloadId: apply.downloadId, tokenConsumed: true };
    }
    if (applyRun.timedOut) return { completed: false, limitation: `Headless Chromium did not complete production saveAs:true within ${applyTimeoutMs} ms.`, applyRun, zipPath };
    const apply = parseOnlyJson(applyRun.stdout);
    if (applyRun.code !== 0) {
      const limitation = apply.error || applyRun.stderr || "Headless Chromium rejected production saveAs:true.";
      if (applyRun.code !== 4 || !/Save As|interrupted (?:the )?ZIP download|did not start (?:the )?ZIP download/iu.test(limitation)) {
        throw new Error(`The production download pipeline failed for a reason other than the headless Save As limitation: ${limitation}`);
      }
      return { completed: false, limitation, applyRun, zipPath };
    }
    if (!zipPath) throw new Error("The CLI reported download success, but Chromium produced no completed ZIP.");
    assert.deepEqual(apply.succeeded, requested);
    assert.deepEqual(apply.skipped, []);
    assert.deepEqual(apply.failed, []);
    assert.deepEqual(apply.remaining, []);
    const verified = await verifyZip(zipPath, apply);
    return { completed: true, apply, verified };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(browserProcess);
  }
}

const integrationRoot = await mkdtemp(join(tmpdir(), "teal-download-browser-integration-"));
assertTemporaryPath(integrationRoot);
const server = spawn("python", [serverPath], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, TEAL_MOCK_PORT: "8769" },
  stdio: ["ignore", "ignore", "pipe"]
});
let serverLog = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverLog = appendCapped(serverLog, chunk); });

try {
  await waitForHttp(fixtureUrl, 15_000);
  const production = await runBrowserPhase(join(integrationRoot, "production-save-as"), {
    bypassHeadlessSaveAs: false,
    applyTimeoutMs: 45_000
  });
  let summary;
  if (production.completed) {
    summary = { ok: true, fixtureUrl, saveAsHeadlessSupported: true, controlledFallbackUsed: false, ...production.verified };
  } else {
    const controlled = await runBrowserPhase(join(integrationRoot, "controlled-headless-fallback"), {
      bypassHeadlessSaveAs: true,
      applyTimeoutMs: 90_000
    });
    if (!controlled.completed) {
      throw new Error(`The controlled test-only saveAs:false pipeline also failed: ${controlled.limitation}`);
    }
    summary = {
      ok: true,
      fixtureUrl,
      saveAsHeadlessSupported: false,
      controlledFallbackUsed: true,
      limitation: production.limitation,
      productionApplyWasNotRetried: true,
      ...controlled.verified
    };
  }
  const indeterminate = await runBrowserPhase(join(integrationRoot, "indeterminate-started-timeout"), {
    bypassHeadlessSaveAs: false,
    simulateIndeterminateTimeout: true,
    applyTimeoutMs: 15_000
  });
  summary.indeterminateStartedTimeout = {
    verified: indeterminate.completed,
    downloadId: indeterminate.downloadId,
    tokenConsumed: indeterminate.tokenConsumed,
    blobPreserved: true,
    dispatchCount: 1
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  if (serverLog) process.stderr.write(serverLog);
  throw error;
} finally {
  await stopChild(server);
  assertTemporaryPath(integrationRoot);
  await rm(integrationRoot, { recursive: true, force: true });
}
