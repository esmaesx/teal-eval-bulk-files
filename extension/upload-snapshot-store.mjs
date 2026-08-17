import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SNAPSHOT_ROOT_NAME = "teal-eval-bulk-files-private-v1";
const SNAPSHOT_NAME_PATTERN = /^upload-([a-f0-9]{48})$/u;
const METADATA_NAME = ".teal-upload-snapshot.json";
const METADATA_SCHEMA_VERSION = 1;
const MAX_ACL_OUTPUT_BYTES = 8 * 1024;

function safeAclFailure(result, path) {
  return String(result?.stderr || result?.stdout || "")
    .replaceAll(path, "[private-root]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function windowsAclEnvironment(path) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLocaleLowerCase("en-US") !== "psmodulepath"));
  env.TEAL_PRIVATE_SNAPSHOT_ACL_PATH = path;
  return env;
}

function defaultSnapshotRoot() {
  return join(resolve(tmpdir()), SNAPSHOT_ROOT_NAME);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

async function runBounded(command, args, timeoutMs = 15_000, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error);
      else resolveRun(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("The Windows snapshot ACL check timed out."));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_ACL_OUTPUT_BYTES); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_ACL_OUTPUT_BYTES); });
    child.once("exit", (code) => finish(null, { code, stdout, stderr }));
  });
}

async function resolveWindowsPowerShell({
  systemRoot = process.env.SystemRoot,
  inspectPath = lstat,
  resolvePath = realpath
} = {}) {
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) throw new Error("The Windows system root was unavailable.");
  const executable = resolve(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  const info = await inspectPath(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The Windows ACL helper was not a plain executable file.");
  if (resolve(await resolvePath(executable)).toLocaleLowerCase("en-US") !== executable.toLocaleLowerCase("en-US")) {
    throw new Error("The Windows ACL helper resolved through another path.");
  }
  return executable;
}

async function secureWindowsSnapshotRoot(rootPath, {
  resolvePowerShellPath = resolveWindowsPowerShell,
  runCommand = runBounded
} = {}) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:TEAL_PRIVATE_SNAPSHOT_ACL_PATH",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleAll($rule)}",
    "$access=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    "$acl.AddAccessRule($access)",
    "[IO.Directory]::SetAccessControl($p,$acl)",
    "$check=Get-Acl -LiteralPath $p",
    "$rules=@($check.Access)",
    "if(-not $check.AreAccessRulesProtected){throw 'ACL inheritance is enabled.'}",
    "if($check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL owner differs.'}",
    "if($rules.Count -ne 1){throw 'ACL has an unexpected rule count.'}",
    "$rule=$rules[0]",
    "if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL principal differs.'}",
    "if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'ACL is not an allow rule.'}",
    "$full=[Security.AccessControl.FileSystemRights]::FullControl",
    "if(($rule.FileSystemRights -band $full) -ne $full){throw 'ACL lacks full control.'}"
  ].join(";");
  const windowsPowerShell = await resolvePowerShellPath();
  const result = await runCommand(
    windowsPowerShell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    15_000,
    windowsAclEnvironment(rootPath)
  );
  if (result.code !== 0) throw new Error(`The private upload snapshot root ACL could not be verified.${safeAclFailure(result, rootPath) ? ` ${safeAclFailure(result, rootPath)}` : ""}`);
}

async function verifyWindowsSnapshotPath(path, {
  resolvePowerShellPath = resolveWindowsPowerShell,
  runCommand = runBounded
} = {}) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:TEAL_PRIVATE_SNAPSHOT_ACL_PATH",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$check=Get-Acl -LiteralPath $p",
    "$rules=@($check.Access)",
    "if(-not $check.AreAccessRulesProtected){throw 'ACL inheritance is enabled.'}",
    "if($check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL owner differs.'}",
    "if($rules.Count -ne 1){throw 'ACL has an unexpected rule count.'}",
    "$rule=$rules[0]",
    "if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL principal differs.'}",
    "if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'ACL is not an allow rule.'}",
    "$full=[Security.AccessControl.FileSystemRights]::FullControl",
    "if(($rule.FileSystemRights -band $full) -ne $full){throw 'ACL lacks full control.'}"
  ].join(";");
  const windowsPowerShell = await resolvePowerShellPath();
  const result = await runCommand(
    windowsPowerShell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    15_000,
    windowsAclEnvironment(path)
  );
  if (result.code !== 0) throw new Error(`The private upload snapshot path ACL could not be verified.${safeAclFailure(result, path) ? ` ${safeAclFailure(result, path)}` : ""}`);
}

async function verifyPosixMode(path, wantedMode, wantedType) {
  const info = await stat(path);
  if ((wantedType === "directory" && !info.isDirectory()) || (wantedType === "file" && !info.isFile())) {
    throw new Error(`The private upload snapshot ${wantedType} type was invalid.`);
  }
  if ((info.mode & 0o777) !== wantedMode) throw new Error(`The private upload snapshot ${wantedType} permissions were not owner-only.`);
  if (typeof process.getuid === "function" && Number.isInteger(info.uid) && info.uid !== process.getuid()) {
    throw new Error(`The private upload snapshot ${wantedType} owner was invalid.`);
  }
}

async function ensurePrivateSnapshotRoot({
  rootPath = defaultSnapshotRoot(),
  create = true,
  platform = process.platform,
  secureWindowsRoot = secureWindowsSnapshotRoot
} = {}) {
  const root = resolve(rootPath);
  if (!isAbsolute(root) || basename(root) !== SNAPSHOT_ROOT_NAME && rootPath === defaultSnapshotRoot()) {
    throw new Error("The private upload snapshot root path was invalid.");
  }
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(root); } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The private upload snapshot root was not a plain directory.");
  if (resolve(await realpath(root)) !== root) throw new Error("The private upload snapshot root resolved through another path.");
  if (platform === "win32") {
    await secureWindowsRoot(root);
  } else {
    await chmod(root, 0o700);
    await verifyPosixMode(root, 0o700, "directory");
  }
  return root;
}

function validateMetadata(value, directoryName = "") {
  if (!exactKeys(value, ["schemaVersion", "nonce", "directoryName", "createdAt", "buildDeadline", "finalizedAt", "retentionDeadline", "state", "files"])
    || value.schemaVersion !== METADATA_SCHEMA_VERSION
    || !/^[a-f0-9]{48}$/u.test(value.nonce || "")
    || value.directoryName !== `upload-${value.nonce}`
    || (directoryName && value.directoryName !== directoryName)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.buildDeadline) || value.buildDeadline <= value.createdAt
    || !["building", "transferring", "browser_active", "retained"].includes(value.state)
    || !Array.isArray(value.files) || value.files.length > 500) {
    throw new Error("The upload snapshot metadata was invalid.");
  }
  const names = new Set();
  for (const file of value.files) {
    if (!exactKeys(file, ["filename", "size", "sha256"])
      || typeof file.filename !== "string" || !file.filename || basename(file.filename) !== file.filename
      || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^[a-f0-9]{64}$/u.test(file.sha256 || "")) throw new Error("The upload snapshot file metadata was invalid.");
    const key = file.filename.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("The upload snapshot metadata had duplicate filenames.");
    names.add(key);
  }
  if (value.state === "building" && (value.files.length || value.finalizedAt !== null || value.retentionDeadline !== null)) {
    throw new Error("The building upload snapshot metadata had ready-state fields.");
  }
  if (value.state !== "building" && (!Number.isSafeInteger(value.finalizedAt) || value.finalizedAt < value.createdAt
    || value.finalizedAt > value.buildDeadline || !Number.isSafeInteger(value.retentionDeadline)
    || value.retentionDeadline <= value.finalizedAt)) throw new Error("The active upload snapshot deadlines were invalid.");
  if (["transferring", "browser_active"].includes(value.state) && !value.files.length) {
    throw new Error("The active upload snapshot file manifest was empty.");
  }
  return value;
}

async function writeMetadata(path, metadata, { replace = false, platform = process.platform } = {}) {
  const target = join(path, METADATA_NAME);
  const destination = replace ? join(path, `.metadata-${metadata.nonce}.tmp`) : target;
  const handle = await open(destination, replace ? "wx" : "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (platform !== "win32") {
    await chmod(destination, 0o600);
    await verifyPosixMode(destination, 0o600, "file");
  }
  if (replace) await rename(destination, target);
  return target;
}

async function removeFreshConstructionChild(directory, root, expectedInfo = null) {
  const target = resolve(directory);
  if (dirname(target) !== root || !SNAPSHOT_NAME_PATTERN.test(basename(target))) {
    throw new Error("The failed upload snapshot construction path was not an exact private-root child.");
  }
  const current = await lstat(target);
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("The failed upload snapshot construction path changed type or became a reparse point.");
  if (expectedInfo && (current.dev !== expectedInfo.dev || current.ino !== expectedInfo.ino)) {
    throw new Error("The failed upload snapshot construction path identity changed.");
  }
  if (dirname(resolve(await realpath(target))) !== root) throw new Error("The failed upload snapshot construction path resolved outside the private root.");
  await rm(target, { recursive: true, force: false });
}

async function createPrivateSnapshotContainer({
  buildTimeoutMs,
  now = Date.now(),
  rootPath = defaultSnapshotRoot(),
  platform = process.platform,
  secureWindowsRoot = secureWindowsSnapshotRoot,
  secureWindowsChild = secureWindowsSnapshotRoot,
  randomNonce = () => randomBytes(24).toString("hex"),
  inspectCreatedChild = lstat,
  writeMetadataFile = writeMetadata,
  cleanupConstructionChild = removeFreshConstructionChild
} = {}) {
  if (!Number.isSafeInteger(buildTimeoutMs) || buildTimeoutMs < 1 || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + buildTimeoutMs)) {
    throw new Error("The upload snapshot build deadline was invalid.");
  }
  const root = await ensurePrivateSnapshotRoot({ rootPath, platform, secureWindowsRoot });
  const nonce = randomNonce();
  if (!/^[a-f0-9]{48}$/u.test(nonce || "")) throw new Error("The upload snapshot nonce was invalid.");
  const directoryName = `upload-${nonce}`;
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  let info = null;
  try {
    info = await inspectCreatedChild(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || dirname(resolve(directory)) !== root) throw new Error("The upload snapshot directory was unsafe.");
    if (platform === "win32") {
      await secureWindowsChild(directory);
    } else {
      await chmod(directory, 0o700);
      await verifyPosixMode(directory, 0o700, "directory");
    }
    const metadata = validateMetadata({
      schemaVersion: METADATA_SCHEMA_VERSION,
      nonce,
      directoryName,
      createdAt: now,
      buildDeadline: now + buildTimeoutMs,
      finalizedAt: null,
      retentionDeadline: null,
      state: "building",
      files: []
    }, directoryName);
    await writeMetadataFile(directory, metadata, { platform });
    return { root, directory, nonce, createdAt: now, buildDeadline: metadata.buildDeadline, retentionDeadline: null, metadata };
  } catch (error) {
    try {
      await cleanupConstructionChild(directory, root, info);
    } catch (cleanupError) {
      throw new Error("Upload snapshot construction failed, and its changed or ambiguous child was left unchanged.", { cause: cleanupError });
    }
    throw error;
  }
}

async function finalizePrivateSnapshot(container, files, {
  platform = process.platform,
  now = Date.now(),
  transferLeaseMs
} = {}) {
  if (!container?.directory || !container?.metadata) throw new Error("The upload snapshot container was invalid.");
  if (!Number.isSafeInteger(now) || now < container.metadata.createdAt || now > container.metadata.buildDeadline
    || !Number.isSafeInteger(transferLeaseMs) || transferLeaseMs < 1 || !Number.isSafeInteger(now + transferLeaseMs)) {
    throw new Error("The upload snapshot could not be finalized within its build deadline.");
  }
  const metadata = validateMetadata({
    ...container.metadata,
    finalizedAt: now,
    retentionDeadline: now + transferLeaseMs,
    state: "transferring",
    files
  }, basename(container.directory));
  await writeMetadata(container.directory, metadata, { replace: true, platform });
  return { ...container, retentionDeadline: metadata.retentionDeadline, metadata };
}

async function renewPrivateSnapshot(snapshot, {
  state,
  lifetimeMs,
  now = Date.now(),
  platform = process.platform,
  secureWindowsRoot = secureWindowsSnapshotRoot,
  verifyWindowsPath = verifyWindowsSnapshotPath
} = {}) {
  if (!snapshot?.directory || !["transferring", "browser_active", "retained"].includes(state)
    || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || !Number.isSafeInteger(now + lifetimeMs)) {
    throw new Error("The upload snapshot renewal request was invalid.");
  }
  const inspected = await inspectPrivateSnapshot(snapshot.directory, {
    rootPath: snapshot.root,
    platform,
    secureWindowsRoot,
    verifyWindowsPath
  });
  const currentState = inspected.metadata.state;
  const allowed = currentState === "building"
    ? ["retained"]
    : currentState === "transferring"
      ? ["transferring", "browser_active", "retained"]
      : currentState === "browser_active"
        ? ["browser_active", "retained"]
        : ["retained"];
  const currentStart = currentState === "building" ? inspected.metadata.createdAt : inspected.metadata.finalizedAt;
  const currentDeadline = currentState === "building" ? inspected.metadata.buildDeadline : inspected.metadata.retentionDeadline;
  if (!allowed.includes(state) || now < currentStart || now > currentDeadline) {
    throw new Error("The upload snapshot state transition was invalid or its current deadline expired.");
  }
  const metadata = validateMetadata({
    ...inspected.metadata,
    state,
    ...(currentState === "building" ? { finalizedAt: now } : {}),
    retentionDeadline: now + lifetimeMs
  }, basename(snapshot.directory));
  await writeMetadata(snapshot.directory, metadata, { replace: true, platform });
  return { ...snapshot, retentionDeadline: metadata.retentionDeadline, metadata };
}

async function inspectPrivateSnapshot(directory, {
  rootPath = defaultSnapshotRoot(),
  platform = process.platform,
  secureWindowsRoot = secureWindowsSnapshotRoot,
  verifyWindowsPath = verifyWindowsSnapshotPath
} = {}) {
  const root = await ensurePrivateSnapshotRoot({ rootPath, create: false, platform, secureWindowsRoot });
  if (!root) throw new Error("The private upload snapshot root was absent.");
  const target = resolve(directory);
  const match = SNAPSHOT_NAME_PATTERN.exec(basename(target));
  if (!match || dirname(target) !== root) throw new Error("The upload snapshot was not an exact child of the private root.");
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The upload snapshot directory was a reparse point or invalid type.");
  if (dirname(resolve(await realpath(target))) !== root) throw new Error("The upload snapshot resolved outside the private root.");
  if (platform === "win32") await verifyWindowsPath(target);
  const metadataPath = join(target, METADATA_NAME);
  const metadataInfo = await lstat(metadataPath);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new Error("The upload snapshot metadata was a reparse point or invalid type.");
  if (platform !== "win32") {
    await verifyPosixMode(target, 0o700, "directory");
    await verifyPosixMode(metadataPath, 0o600, "file");
  }
  const metadata = validateMetadata(JSON.parse(await readFile(metadataPath, "utf8")), basename(target));
  if (metadata.nonce !== match[1]) throw new Error("The upload snapshot nonce did not match its directory.");
  if (metadata.state !== "building") {
    for (const file of metadata.files) {
      const filePath = join(target, file.filename);
      const fileInfo = await lstat(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== file.size || dirname(resolve(filePath)) !== target) {
        throw new Error("The upload snapshot file was a reparse point or did not match its metadata.");
      }
      if (platform !== "win32") await verifyPosixMode(filePath, 0o600, "file");
    }
  }
  return { root, directory: target, metadata };
}

async function removePrivateSnapshot(directory, options = {}) {
  let inspected;
  try { inspected = await inspectPrivateSnapshot(directory, options); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (options.expectedNonce && inspected.metadata.nonce !== options.expectedNonce) throw new Error("The upload snapshot cleanup nonce did not match.");
  if (Object.prototype.hasOwnProperty.call(options, "expectedDeadline") && inspected.metadata.retentionDeadline !== options.expectedDeadline) {
    throw new Error("The upload snapshot cleanup deadline did not match.");
  }
  await rm(inspected.directory, { recursive: true, force: false });
  try {
    await lstat(inspected.directory);
    throw new Error("The upload snapshot directory remained after cleanup.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
}

async function scavengeExpiredPrivateSnapshots({
  rootPath = defaultSnapshotRoot(),
  now = Date.now(),
  platform = process.platform,
  secureWindowsRoot = secureWindowsSnapshotRoot,
  verifyWindowsPath = verifyWindowsSnapshotPath,
  removeSnapshot = removePrivateSnapshot
} = {}) {
  const warnings = [];
  const root = await ensurePrivateSnapshotRoot({ rootPath, create: false, platform, secureWindowsRoot }).catch((error) => {
    warnings.push("The private upload snapshot root could not be verified. No stale snapshot was removed.");
    return null;
  });
  if (!root) return { removed: 0, active: 0, warnings };
  let removed = 0;
  let active = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!SNAPSHOT_NAME_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      warnings.push("An ambiguous private upload snapshot entry was left unchanged.");
      continue;
    }
    const directory = join(root, entry.name);
    try {
      const inspected = await inspectPrivateSnapshot(directory, { rootPath: root, platform, secureWindowsRoot, verifyWindowsPath });
      const cleanupDeadline = inspected.metadata.state === "building"
        ? inspected.metadata.buildDeadline
        : inspected.metadata.retentionDeadline;
      if (cleanupDeadline > now) {
        active += 1;
        continue;
      }
      await removeSnapshot(directory, {
        rootPath: root,
        platform,
        secureWindowsRoot,
        verifyWindowsPath,
        expectedNonce: inspected.metadata.nonce,
        expectedDeadline: inspected.metadata.retentionDeadline
      });
      removed += 1;
    } catch {
      warnings.push("An ambiguous or undeletable private upload snapshot was left unchanged.");
    }
  }
  return { removed, active, warnings };
}

export {
  METADATA_NAME,
  SNAPSHOT_ROOT_NAME,
  createPrivateSnapshotContainer,
  defaultSnapshotRoot,
  ensurePrivateSnapshotRoot,
  finalizePrivateSnapshot,
  inspectPrivateSnapshot,
  removePrivateSnapshot,
  resolveWindowsPowerShell,
  renewPrivateSnapshot,
  scavengeExpiredPrivateSnapshots,
  secureWindowsSnapshotRoot,
  verifyWindowsSnapshotPath,
  validateMetadata,
  verifyPosixMode
};
