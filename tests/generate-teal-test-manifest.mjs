#!/usr/bin/env node
// Generates only a local TAB-TEST manifest. Extension sources stay byte-identical.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const extensionRoot = resolve(import.meta.dirname, "..", "extension");
const productionPath = resolve(extensionRoot, "manifest.json");
const outputPath = process.argv[2];

if (!outputPath) {
  process.stderr.write("Usage: node generate-teal-test-manifest.mjs <output-manifest-path>\n");
  process.exitCode = 2;
} else {
  const manifest = JSON.parse(await readFile(productionPath, "utf8"));
  const localMatch = "http://127.0.0.1:8769/issue/*";
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "http://127.0.0.1:8769/*"])];
  manifest.content_scripts = (manifest.content_scripts || []).map((script) => ({
    ...script,
    matches: [...new Set([...(script.matches || []), localMatch])]
  }));
  await writeFile(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
