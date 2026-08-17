#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";

import { applyPlan, createPlan } from "../extension/teal-eval-bulk-cli.mjs";

const [mode, statePath, eventPath, token, workerId, readyPath, releasePath] = process.argv.slice(2);
const staged = { filename: "race.txt", sha256: "f".repeat(64), sizeText: "4 B" };

await writeFile(readyPath, workerId, "utf8");
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  try {
    if ((await readFile(releasePath, "utf8")).trim() === "go") break;
  } catch { }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
}

const client = {
  mode: "direct",
  targetId: "target_7",
  targetUrl: "http://127.0.0.1:8769/issue/TAB-TEST",
  targetTitle: "TAB-TEST local fixture",
  documentId: "",
  sessionId: null,
  async request(method, params) {
    if (method !== "Runtime.callFunctionOn") throw new Error(`Unexpected method ${method}.`);
    const command = params.arguments[0].value;
    if (command.command === "list") return { result: { value: { ok: true, inventory: [staged] } } };
    if (command.command === "plan-delete") return { result: { value: {
      ok: true,
      operation: "delete",
      requestedNames: [staged.filename],
      actionableNames: [staged.filename],
      skipped: [],
      inventory: [staged],
      authorizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    } } };
    if (command.command === "apply-delete") {
      await appendFile(eventPath, `${workerId}\n`, "utf8");
      return { result: { value: { ok: true, operation: "delete", succeeded: [staged.filename], skipped: [], failed: [], remaining: [] } } };
    }
    throw new Error(`Unexpected command ${command.command}.`);
  }
};

try {
  const result = mode === "apply-delete"
    ? await applyPlan({ command: "apply-delete", operands: [token], issueIdentifier: "TAB-TEST", statePath }, client, 9)
    : await createPlan({ command: "plan-delete", operands: [staged.filename], issueIdentifier: "TAB-TEST", statePath, ttlMs: 60_000 }, client, 9);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), errorKind: error?.errorKind || "" })}\n`);
  process.exitCode = 4;
}
