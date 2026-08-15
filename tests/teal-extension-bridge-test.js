"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const script = fs.readFileSync(path.join(root, "content.js"), "utf8");

assert.equal(fs.existsSync(path.join(root, "download-bridge.js")), false);
assert.equal(manifest.content_scripts.length, 1);
assert.equal(manifest.content_scripts[0].world, undefined);
assert.deepEqual(manifest.content_scripts[0].js, ["zip-builder.js", "content.js"]);
assert.match(script, /attachShadow\(\{ mode: "closed" \}\)/);
assert.equal(/window\.confirm/.test(script), false);
assert.match(script, /event\.isTrusted\) closeConfirmation\(true\)/);
assert.match(script, /teal-eval-bulk-command-v1/);
console.log("isolated bridge contract tests passed");
