import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import uploadLifetime from "../extension/upload-lifetime.js";
import { cleanSnapshotAtDeadline } from "../extension/upload-snapshot-cleaner.mjs";
import {
  createPrivateSnapshotContainer,
  ensurePrivateSnapshotRoot,
  finalizePrivateSnapshot,
  renewPrivateSnapshot,
  resolveWindowsPowerShell,
  secureWindowsSnapshotRoot,
  scavengeExpiredPrivateSnapshots
} from "../extension/upload-snapshot-store.mjs";
import { retainUploadSnapshot, scheduleUploadSnapshotCleanup } from "../extension/teal-eval-bulk-cli.mjs";

const fakeWindowsAcl = async () => {};

async function makeSnapshot(rootPath, { now, retentionMs }) {
  const container = await createPrivateSnapshotContainer({
    rootPath,
    now,
    buildTimeoutMs: 60 * 60 * 1000,
    platform: "win32",
    secureWindowsRoot: fakeWindowsAcl,
    secureWindowsChild: fakeWindowsAcl
  });
  const bytes = Buffer.from("private approved bytes", "utf8");
  const path = join(container.directory, "approved.txt");
  await writeFile(path, bytes);
  const snapshot = await finalizePrivateSnapshot(container, [{
    filename: "approved.txt",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }], { platform: "win32", now: now + 1, transferLeaseMs: retentionMs });
  return { ...snapshot, filePath: path };
}

test("upload lifetime values preserve the browser, CLI, retention, and cleaner order", () => {
  assert.ok(uploadLifetime.contentBatchTimeoutMs < uploadLifetime.cliApplyTimeoutMs);
  assert.ok(uploadLifetime.snapshotRetentionMs >= uploadLifetime.contentBatchTimeoutMs + uploadLifetime.snapshotSafetyMarginMs);
  assert.ok(uploadLifetime.snapshotRetentionMs <= uploadLifetime.snapshotCleanerMaxDelayMs);
});

test("private-root creation requires the injected Windows ACL verifier", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-acl-injected-"));
  const rootPath = join(temp, "private-root");
  const calls = [];
  try {
    const root = await ensurePrivateSnapshotRoot({
      rootPath,
      platform: "win32",
      secureWindowsRoot: async (path) => { calls.push(path); }
    });
    assert.equal(root, rootPath);
    assert.deepEqual(calls, [rootPath]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Windows ACL source requires the exact SystemRoot executable and never PATH lookup", async () => {
  const source = await readFile(new URL("../extension/upload-snapshot-store.mjs", import.meta.url), "utf8");
  assert.match(source, /join\(systemRoot,\s*"System32",\s*"WindowsPowerShell",\s*"v1\.0",\s*"powershell\.exe"\)/u);
  assert.match(source, /typeof systemRoot !== "string" \|\| !isAbsolute\(systemRoot\)/u);
  assert.match(source, /info\.isFile\(\)\s*\|\|\s*info\.isSymbolicLink\(\)/u);
  assert.match(source, /resolve\(await resolvePath\(executable\)\).*executable/u);
  assert.doesNotMatch(source, /spawn\(\s*["']powershell\.exe["']/iu);
});

test("Windows ACL execution uses the exact validated SystemRoot executable and never PATH lookup", {
  skip: process.platform === "win32" ? false : "The executable-path behavior check requires Windows path rules."
}, async () => {
  const systemRoot = "C:\\Windows";
  const expected = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const resolved = await resolveWindowsPowerShell({
    systemRoot,
    inspectPath: async (path) => {
      assert.equal(path, expected);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    resolvePath: async (path) => path
  });
  assert.equal(resolved, expected);

  let executed = "";
  await secureWindowsSnapshotRoot("C:\\private-snapshot-root", {
    resolvePowerShellPath: async () => expected,
    runCommand: async (command) => {
      executed = command;
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(executed, expected);
  assert.notEqual(executed.toLocaleLowerCase("en-US"), "powershell.exe");
});

test("construction failures remove the unchanged fresh child before metadata exists", async () => {
  for (const scenario of ["lstat", "acl", "metadata"]) {
    const temp = await mkdtemp(join(tmpdir(), `teal-snapshot-construction-${scenario}-`));
    const rootPath = join(temp, "private-root");
    try {
      const options = {
        rootPath,
        buildTimeoutMs: 1_000,
        platform: "win32",
        secureWindowsRoot: fakeWindowsAcl,
        secureWindowsChild: scenario === "acl" ? async () => { throw new Error("injected ACL failure"); } : fakeWindowsAcl,
        inspectCreatedChild: scenario === "lstat" ? async () => { throw new Error("injected lstat failure"); } : lstat,
        writeMetadataFile: scenario === "metadata" ? async () => { throw new Error("injected metadata failure"); } : undefined,
        randomNonce: () => ({ lstat: "a", acl: "b", metadata: "c" })[scenario].repeat(48)
      };
      if (options.writeMetadataFile === undefined) delete options.writeMetadataFile;
      await assert.rejects(() => createPrivateSnapshotContainer(options), /injected|snapshot/u);
      assert.deepEqual(await readdir(rootPath), [], `${scenario} failure left a child directory`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("construction cleanup refuses a child whose identity changes to a reparse point", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-construction-reparse-"));
  const rootPath = join(temp, "private-root");
  const target = join(temp, "outside-target");
  await mkdir(target);
  const marker = join(target, "marker.txt");
  await writeFile(marker, "must remain", "utf8");
  try {
    const nonce = "d".repeat(48);
    let linkCreated = false;
    const writeMetadataFile = async (directory) => {
      await rm(directory, { recursive: true, force: false });
      try {
        await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
        linkCreated = true;
      } catch (error) {
        throw Object.assign(new Error("host cannot create reparse fixture"), { cause: error });
      }
      throw new Error("injected metadata failure after replacement");
    };
    try {
      await assert.rejects(() => createPrivateSnapshotContainer({
        rootPath,
        buildTimeoutMs: 1_000,
        platform: "win32",
        secureWindowsRoot: fakeWindowsAcl,
        secureWindowsChild: fakeWindowsAcl,
        randomNonce: () => nonce,
        writeMetadataFile
      }), /left unchanged|host cannot create reparse fixture/u);
    } catch (error) {
      if (!linkCreated) {
        t.skip(`The host cannot create a local reparse fixture: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    assert.equal(await readFile(marker, "utf8"), "must remain");
    assert.equal((await lstat(join(rootPath, `upload-${nonce}`))).isSymbolicLink(), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the real platform private-root check is owner-only when the host supports it", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-acl-real-"));
  const rootPath = join(temp, "private-root");
  try {
    try {
      await ensurePrivateSnapshotRoot({ rootPath });
    } catch (error) {
      t.skip(`The host cannot verify private snapshot ACL or mode semantics: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const info = await lstat(rootPath);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("restart scavenging removes only expired exact snapshots and preserves active snapshots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-scavenge-"));
  const rootPath = join(temp, "private-root");
  try {
    const expired = await makeSnapshot(rootPath, { now: 1_000, retentionMs: 100 });
    const active = await makeSnapshot(rootPath, { now: 1_000, retentionMs: 10_000 });
    const result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 2_000,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.removed, 1);
    assert.equal(result.active, 1);
    assert.deepEqual(result.warnings, []);
    await assert.rejects(readFile(expired.filePath), (error) => error?.code === "ENOENT");
    assert.equal(await readFile(active.filePath, "utf8"), "private approved bytes");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("building snapshots use a separate deadline and cannot finalize after it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-build-deadline-"));
  const rootPath = join(temp, "private-root");
  try {
    const container = await createPrivateSnapshotContainer({
      rootPath,
      now: 1_000,
      buildTimeoutMs: 1_000,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      secureWindowsChild: fakeWindowsAcl
    });
    let result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 1_999,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.active, 1);
    assert.equal(result.removed, 0);
    await assert.rejects(() => finalizePrivateSnapshot(container, [{
      filename: "late.txt",
      size: 1,
      sha256: "a".repeat(64)
    }], { platform: "win32", now: 2_001, transferLeaseMs: 10_000 }), /build deadline/u);
    result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 2_001,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.removed, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a valid building snapshot can enter retained state before its build deadline", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-building-retained-"));
  const rootPath = join(temp, "private-root");
  try {
    const container = await createPrivateSnapshotContainer({
      rootPath,
      now: 1_000,
      buildTimeoutMs: 1_000,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      secureWindowsChild: fakeWindowsAcl
    });
    const retained = await renewPrivateSnapshot(container, {
      state: "retained",
      lifetimeMs: 10_000,
      now: 1_500,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(retained.metadata.state, "retained");
    assert.equal(retained.metadata.finalizedAt, 1_500);
    assert.equal(retained.retentionDeadline, 11_500);
    assert.deepEqual(retained.metadata.files, []);
    let result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 2_001,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.active, 1);
    assert.equal(result.removed, 0);
    result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 11_501,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.removed, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("transfer renewals survive long multi-file selection and browser-active retention starts after transfer", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-transfer-lifetime-"));
  const rootPath = join(temp, "private-root");
  const minute = 60 * 1000;
  try {
    const createdAt = 1_000;
    const container = await createPrivateSnapshotContainer({
      rootPath,
      now: createdAt,
      buildTimeoutMs: 60 * minute,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      secureWindowsChild: fakeWindowsAcl
    });
    const bytes = Buffer.from("slow copied bytes", "utf8");
    const path = join(container.directory, "slow.txt");
    await writeFile(path, bytes);
    let snapshot = await finalizePrivateSnapshot(container, [{
      filename: "slow.txt",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }], {
      platform: "win32",
      now: createdAt + 31 * minute,
      transferLeaseMs: uploadLifetime.snapshotTransferLeaseMs
    });
    assert.equal(snapshot.metadata.finalizedAt, createdAt + 31 * minute);
    assert.equal(snapshot.retentionDeadline, snapshot.metadata.finalizedAt + uploadLifetime.snapshotTransferLeaseMs);

    for (const offset of [39, 47, 55, 63]) {
      const now = createdAt + offset * minute;
      snapshot = await renewPrivateSnapshot(snapshot, {
        state: "transferring",
        lifetimeMs: uploadLifetime.snapshotTransferLeaseMs,
        now,
        platform: "win32",
        secureWindowsRoot: fakeWindowsAcl,
        verifyWindowsPath: fakeWindowsAcl
      });
      const concurrent = await scavengeExpiredPrivateSnapshots({
        rootPath,
        now: now + 1,
        platform: "win32",
        secureWindowsRoot: fakeWindowsAcl,
        verifyWindowsPath: fakeWindowsAcl
      });
      assert.equal(concurrent.active, 1);
      assert.equal(concurrent.removed, 0);
    }

    const browserStartedAt = createdAt + 64 * minute;
    snapshot = await renewPrivateSnapshot(snapshot, {
      state: "browser_active",
      lifetimeMs: uploadLifetime.snapshotRetentionMs,
      now: browserStartedAt,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(snapshot.retentionDeadline, browserStartedAt + uploadLifetime.snapshotRetentionMs);
    const active = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: browserStartedAt + uploadLifetime.contentBatchTimeoutMs,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(active.active, 1);
    assert.equal(active.removed, 0);
    const expired = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: snapshot.retentionDeadline + 1,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(expired.removed, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a crash during transfer preserves the snapshot past page selection TTL and then scavenges it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-transfer-crash-"));
  const rootPath = join(temp, "private-root");
  const minute = 60 * 1000;
  try {
    let snapshot = await makeSnapshot(rootPath, { now: 1_000, retentionMs: uploadLifetime.snapshotTransferLeaseMs });
    snapshot = await renewPrivateSnapshot(snapshot, {
      state: "transferring",
      lifetimeMs: uploadLifetime.snapshotTransferLeaseMs,
      now: 1_000 + 2 * minute,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    const afterPageTtl = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 1_000 + 2 * minute + 5 * minute + 1,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(afterPageTtl.active, 1);
    const expired = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: snapshot.retentionDeadline + 1,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(expired.removed, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scavenging refuses a reparse snapshot child", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-reparse-"));
  const rootPath = join(temp, "private-root");
  const target = join(temp, "outside-target");
  try {
    await ensurePrivateSnapshotRoot({ rootPath, platform: "win32", secureWindowsRoot: fakeWindowsAcl });
    await ensurePrivateSnapshotRoot({ rootPath: target, platform: "win32", secureWindowsRoot: fakeWindowsAcl });
    const marker = join(target, "marker.txt");
    await writeFile(marker, "must remain", "utf8");
    const link = join(rootPath, `upload-${"a".repeat(48)}`);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`The host cannot create a local reparse fixture: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: Number.MAX_SAFE_INTEGER,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl
    });
    assert.equal(result.removed, 0);
    assert.ok(result.warnings.length >= 1);
    assert.equal(await readFile(marker, "utf8"), "must remain");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scavenging reports delete failure and leaves the exact snapshot", async () => {
  const temp = await mkdtemp(join(tmpdir(), "teal-snapshot-delete-failure-"));
  const rootPath = join(temp, "private-root");
  try {
    const expired = await makeSnapshot(rootPath, { now: 1_000, retentionMs: 100 });
    const result = await scavengeExpiredPrivateSnapshots({
      rootPath,
      now: 2_000,
      platform: "win32",
      secureWindowsRoot: fakeWindowsAcl,
      verifyWindowsPath: fakeWindowsAcl,
      removeSnapshot: async () => { throw new Error("injected delete failure"); }
    });
    assert.equal(result.removed, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(await readFile(expired.filePath, "utf8"), "private approved bytes");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("cleaner delete failure is terminal and is not suppressed", async () => {
  await assert.rejects(() => cleanSnapshotAtDeadline({
    directory: "C:\\safe-test-only",
    nonce: "b".repeat(48),
    retentionDeadline: 1_000
  }, {
    now: () => 1_000,
    inspectSnapshot: async () => ({
      root: "C:\\root",
      metadata: { nonce: "b".repeat(48), retentionDeadline: 1_000 }
    }),
    removeSnapshot: async () => { throw new Error("injected cleaner delete failure"); }
  }), /delete failure/u);
});

test("immediate cleaner spawn failure returns a structured no-retry warning", async () => {
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const scheduled = scheduleUploadSnapshotCleanup({
    directory: "C:\\safe-test-only",
    nonce: "c".repeat(48),
    retentionDeadline: Date.now() + 1_000
  }, () => {
    process.nextTick(() => fakeChild.emit("error", new Error("spawn failed")));
    return fakeChild;
  });
  await assert.rejects(scheduled, /spawn failed/u);

  const warning = await retainUploadSnapshot({}, {
    renewUploadSnapshotForTest: async (snapshot, options) => ({
      ...snapshot,
      retentionDeadline: options.now + options.lifetimeMs,
      metadata: { state: options.state, retentionDeadline: options.now + options.lifetimeMs }
    }),
    scheduleUploadSnapshotCleanupForTest: async () => { throw new Error("spawn failed"); }
  }, {
    directory: "C:\\safe-test-only",
    nonce: "c".repeat(48),
    retentionDeadline: Date.now() + 1_000
  });
  assert.equal(warning.kind, "snapshot_cleanup_not_scheduled");
  assert.match(warning.message, /indeterminate/u);
  assert.match(warning.message, /must not be retried/u);
});
