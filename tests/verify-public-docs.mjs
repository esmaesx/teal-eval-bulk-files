#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expectedImages = [
  "docs/images/eval-page-overview.png",
  "docs/images/upload-mode.png",
  "docs/images/download-mode.png",
  "docs/images/delete-mode.png",
  "docs/images/cli-plan-example.png"
];
const excludedParts = new Set([".git", ".codex", "node_modules", "artifacts"]);
const forbiddenInternalLabel = /tab-test/i;
const realIssueUrl = /https:\/\/platform-teal-alpha\.vercel\.app\/issue\/[A-Z][A-Z0-9]+-\d+/i;
const releaseDocs = [
  "README.md",
  "CHANGELOG.md",
  "extension/README.md",
  "docs/cli-guide.md",
  "skill/SKILL.md",
  "skill/references/cli-contract.md"
];
const agentSafetyDocs = [
  "README.md",
  "extension/README.md",
  "docs/cli-guide.md",
  "skill/SKILL.md",
  "skill/references/cli-contract.md"
];

async function collectMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedParts.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function pngDimensions(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature || buffer.length < 24) {
    throw new Error("Not a valid PNG header.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const failures = [];
for (const path of await collectMarkdown(root)) {
  const content = await readFile(path, "utf8");
  const display = relative(root, path).split(sep).join("/");
  if (forbiddenInternalLabel.test(content)) failures.push(`${display}: contains the private internal route label.`);
  if (realIssueUrl.test(content)) failures.push(`${display}: contains a real-looking production issue URL.`);
}

for (const relativePath of expectedImages) {
  const path = resolve(root, relativePath);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 10_000) failures.push(`${relativePath}: image is missing or too small.`);
    const dimensions = pngDimensions(await readFile(path));
    if (dimensions.width < 700 || dimensions.height < 400) {
      failures.push(`${relativePath}: unexpected dimensions ${dimensions.width}x${dimensions.height}.`);
    }
  } catch (error) {
    failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const relativePath of releaseDocs) {
  const content = await readFile(resolve(root, relativePath), "utf8");
  if (!content.includes("0.9.8")) failures.push(`${relativePath}: does not name release 0.9.8.`);
  if (!content.includes("0.1.3")) failures.push(`${relativePath}: does not name required bridge 0.1.3.`);
}
for (const relativePath of agentSafetyDocs) {
  const content = await readFile(resolve(root, relativePath), "utf8");
  if (!content.includes("-PersistentBridgePath")) failures.push(`${relativePath}: does not require the persistent wrapper for agent file work.`);
  if (!content.includes("chrome-devtools-mcp") || !content.includes("Claude `--chrome`")) {
    failures.push(`${relativePath}: does not warn against direct agent Chrome clients.`);
  }
}
const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
if (!/^## 0\.9\.8 - 2026-08-17$/mu.test(changelog)) failures.push("CHANGELOG.md: missing the dated 0.9.8 entry.");
if (!/^## 0\.9\.7 - 2026-08-17$/mu.test(changelog)) failures.push("CHANGELOG.md: missing the 0.9.7 history entry.");
if (!/^## 0\.9\.6$/mu.test(changelog)) failures.push("CHANGELOG.md: missing the 0.9.6 history entry.");

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Verified public Markdown and ${expectedImages.length} screenshots.\n`);
}
