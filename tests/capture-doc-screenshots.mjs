#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const artifactsRoot = resolve(root, "artifacts", "documentation-capture");
const buildRoot = resolve(artifactsRoot, "extension");
const profileRoot = resolve(artifactsRoot, "profile");
const extensionRoot = resolve(root, "extension");
const imagesRoot = resolve(root, "docs", "images");
const capturePort = Number(process.env.TEAL_DOCS_CAPTURE_PORT || 8879);
if (!Number.isInteger(capturePort) || capturePort < 1024 || capturePort > 65535) {
  throw new Error("TEAL_DOCS_CAPTURE_PORT must be an integer from 1024 through 65535.");
}
const captureOrigin = `http://127.0.0.1:${capturePort}`;
const pageUrl = `${captureOrigin}/issue/DEMO-204?docs=1`;

function assertInsideArtifacts(path) {
  if (!resolve(path).startsWith(`${artifactsRoot}${sep}`) && resolve(path) !== artifactsRoot) {
    throw new Error(`Refusing to change a path outside ${artifactsRoot}`);
  }
}

async function prepareExtensionBuild() {
  assertInsideArtifacts(buildRoot);
  assertInsideArtifacts(profileRoot);
  await rm(artifactsRoot, { recursive: true, force: true });
  await mkdir(artifactsRoot, { recursive: true });
  await cp(extensionRoot, buildRoot, { recursive: true });

  const manifestPath = resolve(buildRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const localMatch = `${captureOrigin}/issue/*`;
  manifest.name = `${manifest.name} · documentation capture`;
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), `${captureOrigin}/*`])];
  manifest.content_scripts = (manifest.content_scripts || []).map((script) => ({
    ...script,
    matches: [...new Set([...(script.matches || []), localMatch])]
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // Production keeps a closed shadow root. The isolated documentation copy is
  // opened only so Playwright can select fake files and deterministic controls.
  const contentPath = resolve(buildRoot, "content.js");
  const content = await readFile(contentPath, "utf8");
  const opened = content.replace(
    'host.attachShadow({ mode: "closed" })',
    'host.attachShadow({ mode: "open" })'
  );
  if (opened === content) throw new Error("The expected production shadow-root declaration was not found.");
  await writeFile(contentPath, opened, "utf8");
}

async function waitForServer(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Local demo server returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw lastError || new Error("Local demo server did not start.");
}

async function chooseChromium() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const candidate = configured || chromium.executablePath();
  await access(candidate, fsConstants.X_OK);
  return candidate;
}

async function captureCliExample(context) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html>
    <style>
      *{box-sizing:border-box}body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0d0d0f;color:#e8e8e8;font-family:Inter,Segoe UI,sans-serif}.terminal{width:1120px;border:1px solid #2b2b31;border-radius:12px;overflow:hidden;background:#111113;box-shadow:0 24px 70px #0008}.bar{height:45px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid #2b2b31;background:#17171a}.dot{width:11px;height:11px;border-radius:50%}.red{background:#ef6464}.yellow{background:#f2a93b}.green{background:#4cb782}.title{margin-left:9px;color:#8b8c92;font-size:13px}.body{padding:24px 27px 28px;font:15px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.prompt{color:#8a97ff}.key{color:#86d3ae}.muted{color:#8b8c92}.value{color:#f2c66d}
    </style>
    <div class="terminal">
      <div class="bar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span class="title">Teal Eval Bulk Files · CLI example</span></div>
      <div class="body"><span class="prompt">PS&gt;</span> .\\skill\\scripts\\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command list
{
  <span class="key">"issue"</span>: <span class="value">"DEMO-204"</span>,
  <span class="key">"staged"</span>: [<span class="value">"demo_sensor_layout.csv"</span>, <span class="value">"demo_calibration_notes.txt"</span>, <span class="value">"demo_trial_summary.md"</span>]
}

<span class="prompt">PS&gt;</span> .\\skill\\scripts\\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command plan-delete -Names demo_trial_summary.md
{
  <span class="key">"operation"</span>: <span class="value">"delete"</span>, <span class="key">"actionable"</span>: [<span class="value">"demo_trial_summary.md"</span>], <span class="key">"plan_token"</span>: <span class="value">"&lt;one-use-token&gt;"</span>
}

<span class="prompt">PS&gt;</span> .\\skill\\scripts\\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command apply-delete -PlanToken &lt;one-use-token&gt;
{
  <span class="key">"succeeded"</span>: [<span class="value">"demo_trial_summary.md"</span>], <span class="key">"skipped"</span>: [], <span class="key">"failed"</span>: [], <span class="key">"remaining"</span>: []
}
<span class="muted">Example output. Tokens and filenames are fictional.</span></div>
    </div>`);
  await page.locator(".terminal").screenshot({ path: resolve(imagesRoot, "cli-plan-example.png") });
  await page.close();
}

await prepareExtensionBuild();
await mkdir(imagesRoot, { recursive: true });

const server = spawn("python", [resolve(root, "tests", "mock", "server.py")], {
  cwd: root,
  env: { ...process.env, TEAL_MOCK_PORT: String(capturePort) },
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"]
});
let serverError = "";
server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

let context;
try {
  await waitForServer(pageUrl);
  const executablePath = await chooseChromium();
  context = await chromium.launchPersistentContext(profileRoot, {
    executablePath,
    headless: true,
    viewport: { width: 1526, height: 897 },
    colorScheme: "dark",
    args: [
      `--disable-extensions-except=${buildRoot}`,
      `--load-extension=${buildRoot}`,
      "--disable-gpu"
    ]
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(pageUrl, { waitUntil: "networkidle" });
  const bulkButton = page.locator("#teal-eval-bulk-files-v1-button");
  await bulkButton.waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: resolve(imagesRoot, "eval-page-overview.png"), fullPage: true });

  await bulkButton.click();
  const host = page.locator("#teal-eval-bulk-files-v1-host");
  await host.locator(".bulk-input").setInputFiles([
    { name: "candidate_thresholds.csv", mimeType: "text/csv", buffer: Buffer.from("zone,limit\nA,72\n") },
    { name: "sensor_review_notes.txt", mimeType: "text/plain", buffer: Buffer.from("Fictional notes for screenshot capture.\n") },
    { name: "demo_sensor_layout.csv", mimeType: "text/csv", buffer: Buffer.from("duplicate example\n") }
  ]);
  await host.locator(".upload-ack").check();
  await page.screenshot({ path: resolve(imagesRoot, "upload-mode.png") });

  await host.getByRole("button", { name: "Download staged files", exact: true }).click();
  await host.getByRole("button", { name: "Select all", exact: true }).first().click();
  await page.screenshot({ path: resolve(imagesRoot, "download-mode.png") });

  await host.getByRole("button", { name: "Delete staged files", exact: true }).click();
  const deleteChecks = host.locator('[data-delete-key]');
  const deleteCount = Math.min(3, await deleteChecks.count());
  for (let index = 0; index < deleteCount; index += 1) await deleteChecks.nth(index).check();
  await page.screenshot({ path: resolve(imagesRoot, "delete-mode.png") });

  await captureCliExample(context);
  process.stdout.write(`Captured five documentation screenshots in ${imagesRoot}\n`);
} finally {
  if (context) await context.close();
  if (!server.killed) server.kill();
  if (serverError && !/KeyboardInterrupt/.test(serverError)) process.stderr.write(serverError);
}
