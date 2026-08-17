import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = join(root, "extension");
const wrapperPath = join(root, "skill", "scripts", "invoke-teal-cli.ps1");
const fakeProxyPath = fileURLToPath(new URL("./fake-persistent-proxy.mjs", import.meta.url));

function runPowerShell(args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", wrapperPath,
      ...args
    ], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function parseOnlyJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, received ${lines.length}: ${stdout}`);
  return JSON.parse(lines[0]);
}

test("PowerShell wrapper source preserves aliases, transport parameter sets, and the version gate", async () => {
  const wrapperSource = await readFile(wrapperPath, "utf8");
  assert.match(wrapperSource, /Mandatory\s*=\s*\$true,\s*ParameterSetName\s*=\s*'PersistentBridge'[\s\S]*?\$PersistentBridgePath/u);
  assert.match(wrapperSource, /ParameterSetName\s*=\s*'PersistentBridge'[\s\S]*?ValidateRange\(1,\s*300\)[\s\S]*?\$BridgeWaitSeconds\s*=\s*120/u);
  assert.match(wrapperSource, /ParameterSetName\s*=\s*'Cdp'[\s\S]*?\$CdpEndpoint/u);
  assert.match(wrapperSource, /ParameterSetName\s*=\s*'Browser'[\s\S]*?\$Browser/u);
  assert.match(wrapperSource, /\[Alias\('Names',\s*'Files',\s*'Paths',\s*'PlanToken'\)\][\s\S]*?\$Operands/u);
  assert.match(wrapperSource, /\$manifest\.version\s*-ne\s*'0\.9\.7'/u);
  assert.match(wrapperSource, /'--persistent-bridge',\s*\$resolvedPersistentBridgePath/u);
  assert.match(wrapperSource, /'--bridge-wait-seconds',\s*\[string\]\$BridgeWaitSeconds/u);
  assert.match(wrapperSource, /'--target-id',\s*\$TargetId/u);
  assert.match(wrapperSource, /TryCreate\(\$PersistentBridgePath,\s*\[UriKind\]::Absolute/u);
});

test("PowerShell wrapper preserves persistent mapping, parameter sets, version gate, and CLI failures", {
  concurrency: false,
  skip: process.platform === "win32" ? false : "Windows PowerShell 5.1 is required for the wrapper process test."
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-wrapper-contract-"));
  try {
    const statePath = join(temp, "tokens.json");
    const fakeStatePath = `${statePath}.fake`;
    const common = [
      "-PersistentBridgePath", fakeProxyPath,
      "-Issue", "TAB-TEST",
      "-ExtensionRoot", extensionRoot,
      "-StatePath", statePath,
      "-BridgeWaitSeconds", "7"
    ];

    const status = await runPowerShell([...common, "-Command", "status"], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stderr, "");
    const statusJson = parseOnlyJson(status.stdout);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.command, "status");
    assert.equal(statusJson.issueIdentifier, "TAB-TEST");
    const fake = JSON.parse(await readFile(fakeStatePath, "utf8"));
    assert.ok(fake.calls.some((call) => call.name === "list_pages"));
    assert.ok(fake.calls.some((call) => call.name === "select_page"));
    assert.equal(fake.calls.every((call) => call.leaseWaitMs === 7_000), true);
    assert.ok(fake.commandEnvelopes.some((value) => value.command.command === "status"));

    const deletePlan = await runPowerShell([...common, "-Command", "plan-delete", "-Names", "existing-alpha.txt"], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(deletePlan.code, 0, deletePlan.stderr);
    const deletePlanJson = parseOnlyJson(deletePlan.stdout);
    assert.deepEqual(deletePlanJson.actionableNames, ["existing-alpha.txt"]);
    const deleteApply = await runPowerShell([...common, "-Command", "apply-delete", "-PlanToken", deletePlanJson.token], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(deleteApply.code, 0, deleteApply.stderr);
    assert.deepEqual(parseOnlyJson(deleteApply.stdout).succeeded, ["existing-alpha.txt"]);

    const pathsUpload = join(temp, "paths-upload.txt");
    await writeFile(pathsUpload, "paths", "utf8");
    const pathsPlan = await runPowerShell([...common, "-Command", "plan-upload", "-Paths", pathsUpload], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(pathsPlan.code, 0, pathsPlan.stderr);
    assert.deepEqual(parseOnlyJson(pathsPlan.stdout).actionableNames, ["paths-upload.txt"]);

    const filesUpload = join(temp, "files-upload.txt");
    await writeFile(filesUpload, "files", "utf8");
    const filesPlan = await runPowerShell([...common, "-Command", "plan-upload", "-Files", filesUpload], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(filesPlan.code, 0, filesPlan.stderr);
    assert.deepEqual(parseOnlyJson(filesPlan.stdout).actionableNames, ["files-upload.txt"]);

    const mutuallyExclusive = await runPowerShell([
      "-Browser", "chrome",
      "-CdpEndpoint", "http://127.0.0.1:9222",
      "-Issue", "TAB-TEST",
      "-Command", "status",
      "-ExtensionRoot", extensionRoot
    ]);
    assert.notEqual(mutuallyExclusive.code, 0);
    assert.match(mutuallyExclusive.stderr, /parameter set cannot be resolved|parameters cannot be used together/iu);
    assert.equal(mutuallyExclusive.stdout, "");

    for (const invalidWait of ["0", "301"]) {
      const invalid = await runPowerShell([
        "-PersistentBridgePath", fakeProxyPath,
        "-BridgeWaitSeconds", invalidWait,
        "-Issue", "TAB-TEST",
        "-Command", "status",
        "-ExtensionRoot", extensionRoot
      ], { TEAL_FAKE_MCP_STATE: join(temp, `invalid-wait-${invalidWait}.fake`) });
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.stderr, /BridgeWaitSeconds|validation range|less than the minimum|greater than the maximum/iu);
      assert.equal(invalid.stdout, "");
    }

    const browserWait = await runPowerShell([
      "-Browser", "chrome",
      "-BridgeWaitSeconds", "1",
      "-Issue", "TAB-TEST",
      "-Command", "status",
      "-ExtensionRoot", extensionRoot
    ]);
    assert.notEqual(browserWait.code, 0);
    assert.match(browserWait.stderr, /parameter set cannot be resolved|parameters cannot be used together/iu);
    assert.equal(browserWait.stdout, "");

    const missingPersistentPath = join(temp, "missing-persistent-proxy.mjs");
    const missingPersistent = await runPowerShell([
      "-PersistentBridgePath", missingPersistentPath,
      "-Issue", "TAB-TEST",
      "-Command", "status",
      "-ExtensionRoot", extensionRoot
    ]);
    assert.notEqual(missingPersistent.code, 0);
    assert.match(missingPersistent.stderr, /persistent Chrome stdio proxy was not found/iu);
    assert.equal(missingPersistent.stdout, "");

    const relativePersistent = await runPowerShell([
      "-PersistentBridgePath", "relative-persistent-proxy.mjs",
      "-Issue", "TAB-TEST",
      "-Command", "status",
      "-ExtensionRoot", extensionRoot
    ]);
    assert.notEqual(relativePersistent.code, 0);
    assert.match(relativePersistent.stderr, /must be an absolute local file path/iu);
    assert.equal(relativePersistent.stdout, "");

    const oldExtensionRoot = join(temp, "old-extension");
    await mkdir(oldExtensionRoot, { recursive: true });
    await cp(join(extensionRoot, "teal-eval-bulk-cli.mjs"), join(oldExtensionRoot, "teal-eval-bulk-cli.mjs"));
    await writeFile(join(oldExtensionRoot, "manifest.json"), '{"version":"0.9.3"}\n', "utf8");
    const oldVersion = await runPowerShell([
      "-PersistentBridgePath", fakeProxyPath,
      "-Issue", "TAB-TEST",
      "-Command", "status",
      "-ExtensionRoot", oldExtensionRoot
    ], { TEAL_FAKE_MCP_STATE: join(temp, "old-version.fake") });
    assert.notEqual(oldVersion.code, 0);
    assert.match(oldVersion.stderr, /requires Teal Eval Bulk Files 0\.9\.7\. Found 0\.9\.3/iu);
    assert.equal(oldVersion.stdout, "");

    const failedApply = await runPowerShell([
      ...common,
      "-Command", "apply-download",
      "-Operands", "unknown-plan-token"
    ], { TEAL_FAKE_MCP_STATE: fakeStatePath });
    assert.equal(failedApply.code, 4, failedApply.stderr);
    const failedJson = parseOnlyJson(failedApply.stdout);
    assert.equal(failedJson.ok, false);
    assert.match(failedJson.error, /plan token was not found/u);
    assert.match(failedApply.stderr, /plan token was not found/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
