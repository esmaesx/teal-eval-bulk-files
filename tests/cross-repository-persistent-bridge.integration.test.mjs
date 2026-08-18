#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  McpStdioSession,
  PersistentBridgeClient,
} from '../extension/persistent-mcp-client.mjs';

const publicRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const fallbackBridgeRoot = resolve(publicRoot, '..', '..', 'work', 'chrome-devtools-mcp-persistent-bridge');
const cliPath = join(publicRoot, 'extension', 'teal-eval-bulk-cli.mjs');
const proxyRelativePath = join('runtime', 'stdio-proxy.mjs');
const protocolVersion = '2025-06-18';
const tempPrefix = 'teal-cross-repo-bridge-';
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
let bridgeSource;

const contractBackendSource = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const names = [
  'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form',
  'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
  'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
  'resize_page', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot',
  'type_text', 'upload_file', 'wait_for',
];
const pageUrl = 'http://127.0.0.1:8769/issue/TAB-TEST';
const documentId = 'TEST-DOCUMENT-0001';
const resultPrefix = 'TEAL_CLI_RESULT_';
const markers = new Map();

function schemaFor(name) {
  if (name === 'select_page') return {
    type: 'object', required: ['pageId'], additionalProperties: false,
    properties: { pageId: { type: 'number' }, bringToFront: { type: 'boolean' } },
  };
  if (name === 'take_snapshot') return {
    type: 'object', additionalProperties: false, properties: { verbose: { type: 'boolean' } },
  };
  if (name === 'fill') return {
    type: 'object', required: ['uid', 'value'], additionalProperties: false,
    properties: { uid: { type: 'string' }, value: { type: 'string' }, includeSnapshot: { type: 'boolean' } },
  };
  if (name === 'upload_file') return {
    type: 'object', required: ['uid', 'filePath'], additionalProperties: false,
    properties: { uid: { type: 'string' }, filePath: { type: 'string' }, includeSnapshot: { type: 'boolean' } },
  };
  if (name === 'wait_for') return {
    type: 'object', required: ['text'], additionalProperties: false,
    properties: { text: { type: 'array', items: { type: 'string' } }, timeout: { type: 'number' } },
  };
  return { type: 'object', properties: {}, additionalProperties: true };
}

const tools = names.map((name) => ({
  name,
  description: 'Local cross-repository integration test tool.',
  inputSchema: schemaFor(name),
}));

function ok(structuredContent, text = 'ok') {
  return { content: [{ type: 'text', text }], structuredContent };
}

function failure(status, detail) {
  return {
    content: [{ type: 'text', text: detail }],
    structuredContent: { status, detail },
    isError: true,
  };
}

function appendEvent(name, args, command) {
  const path = process.env.TEAL_TEST_EVENTS_FILE;
  if (!path) return;
  appendFileSync(path, JSON.stringify({ name, args, command }) + '\n', 'utf8');
}

function readMode() {
  const path = process.env.TEAL_TEST_MODE_FILE;
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8').trim();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function consumeFailure() {
  const path = process.env.TEAL_TEST_FAILURE_MARKER;
  if (!path || existsSync(path)) return false;
  writeFileSync(path, 'used\n', 'utf8');
  return true;
}

function resultFor(envelope) {
  const command = envelope.command?.command;
  if (command === 'capabilities') return {
    ok: true,
    issueIdentifier: 'TAB-TEST',
    persistentBridgeProtocolVersion: 1,
    extensionVersion: '0.9.8',
    documentId,
    targetUrl: pageUrl,
  };
  if (command === 'status') return { ok: true, operation: 'status', transport: 'local-test', inventoryCount: 0 };
  if (command === 'list') return { ok: true, operation: 'list', files: [] };
  if (typeof command === 'string' && command.startsWith('apply-')) {
    return { ok: true, operation: command.slice('apply-'.length), succeeded: [], skipped: [], failed: [], remaining: [] };
  }
  return { ok: true, operation: command || 'unknown' };
}

function terminalMarker(envelope) {
  const payload = {
    protocolVersion: 1,
    extensionVersion: '0.9.8',
    documentId,
    requestId: envelope.requestId,
    targetUrl: pageUrl,
    command: envelope.command.command,
    state: 'completed',
    result: resultFor(envelope),
  };
  return resultPrefix + envelope.requestId + ':' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

async function callTool(name, args) {
  if (name === 'list_pages') return ok({ pages: [{ id: 1, title: 'Local Teal test page', url: pageUrl, selected: true }] });
  if (name === 'select_page') return ok({ ok: true, selectedPageId: args.pageId });
  if (name === 'take_snapshot') {
    if (process.env.TEAL_TEST_DELAY_TOOL === name && /^\d{1,6}$/.test(process.env.TEAL_TEST_DELAY_MS ?? '')) {
      appendEvent(name, args, { command: 'test-delay' });
      await delay(Number(process.env.TEAL_TEST_DELAY_MS));
    }
    return ok({ snapshot: { id: 'teal-command-uid', name: 'Teal CLI persistent command' } });
  }
  if (name === 'fill') {
    let envelope;
    try { envelope = JSON.parse(args.value); } catch { return failure('invalid_test_envelope', 'The local test envelope was invalid.'); }
    appendEvent(name, { uid: args.uid, includeSnapshot: args.includeSnapshot }, envelope.command);
    const command = envelope.command?.command;
    if (readMode() === 'fail-next-apply-fill' && typeof command === 'string' && command.startsWith('apply-') && consumeFailure()) {
      setTimeout(() => process.exit(23), 5);
      await new Promise(() => {});
    }
    const marker = terminalMarker(envelope);
    markers.set(resultPrefix + envelope.requestId, marker);
    return ok({ ok: true });
  }
  if (name === 'wait_for') {
    for (const requested of args.text ?? []) {
      const marker = markers.get(requested);
      if (marker) return ok({ snapshot: { id: 'terminal-result', name: marker } }, marker);
    }
    if (readMode() === 'fail-next-apply-fill' && existsSync(process.env.TEAL_TEST_FAILURE_MARKER || '')) {
      return failure('test_confirmation_unavailable', 'The local test backend cannot confirm the dispatched apply.');
    }
    return failure('test_wait_timeout', 'The local test wait timed out.');
  }
  return ok({ ok: true, name });
}

const server = new Server(
  { name: 'teal-contract-fake-chrome', version: '1.0.0-test' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name, request.params.arguments ?? {}));
await server.connect(new StdioServerTransport());
`;

function expectContainedPath(root, path, label, { allowRoot = false } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relation = relative(resolvedRoot, resolvedPath);
  assert.ok(
    (allowRoot || relation.length > 0)
      && !isAbsolute(relation)
      && relation !== '..'
      && !relation.startsWith(`..${sep}`),
    `${label} left its approved root.`,
  );
  return resolvedPath;
}

function expectTempRoot(path) {
  const resolved = expectContainedPath(tmpdir(), path, 'The temporary root');
  assert.ok(basename(resolved).startsWith(tempPrefix), 'The temporary root has an unexpected prefix.');
  return resolved;
}

function isLocalAbsolutePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && isAbsolute(path)
    && !/^[\\/]{2}/u.test(path);
}

function filesystemIdentity(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function assertNoReparseChain(root, path, label) {
  const resolvedRoot = resolve(root);
  const resolvedPath = expectContainedPath(resolvedRoot, path, label, { allowRoot: true });
  const relation = relative(resolvedRoot, resolvedPath);
  const segments = relation ? relation.split(/[\\/]+/u) : [];
  let current = resolvedRoot;
  for (const segment of ['', ...segments]) {
    if (segment) current = join(current, segment);
    const stat = await lstat(current);
    assert.equal(stat.isSymbolicLink(), false, `${label} contains a symbolic link or directory reparse point: ${current}`);
  }
}

async function assertSafeDirectory(root, path, label) {
  await assertNoReparseChain(root, path, label);
  const stat = await lstat(path);
  assert.equal(stat.isDirectory(), true, `${label} is not a directory.`);
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  expectContainedPath(realRoot, realPath, `${label} after real-path resolution`, { allowRoot: true });
  return realPath;
}

async function assertSafeRegularFile(root, path, label) {
  await assertNoReparseChain(root, path, label);
  const stat = await lstat(path);
  assert.equal(stat.isFile(), true, `${label} is not a regular file.`);
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  expectContainedPath(realRoot, realPath, `${label} after real-path resolution`);
  return realPath;
}

async function validateBridgeSourceRoot(candidate, origin) {
  assert.equal(
    isLocalAbsolutePath(candidate),
    true,
    `${origin} must be an absolute local directory path.`,
  );
  const root = resolve(candidate);
  await assertSafeDirectory(root, root, `${origin} bridge source root`);
  const runtime = join(root, 'runtime');
  const nodeModules = join(root, 'node_modules');
  const fakeBackend = join(root, 'tests', 'fake-chrome-server.mjs');
  const packagePath = join(root, 'package.json');
  await assertSafeDirectory(root, runtime, 'The bridge runtime source');
  const nodeModulesReal = await assertSafeDirectory(root, nodeModules, 'The bridge dependency source');
  await assertSafeRegularFile(root, fakeBackend, 'The bridge fake backend source');
  await assertSafeRegularFile(root, packagePath, 'The bridge package manifest');
  for (const name of ['daemon.mjs', 'stdio-proxy.mjs', 'allow-remote-debugging.ps1', 'status.ps1']) {
    await assertSafeRegularFile(root, join(runtime, name), `The bridge runtime source file ${name}`);
  }
  const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  return { root, runtime, nodeModules, nodeModulesReal, fakeBackend, packagePath, version: packageManifest.version };
}

async function resolveBridgeSourceRoot() {
  if (Object.hasOwn(process.env, 'TEAL_PERSISTENT_BRIDGE_SOURCE_ROOT')) {
    const configured = String(process.env.TEAL_PERSISTENT_BRIDGE_SOURCE_ROOT || '').trim();
    return validateBridgeSourceRoot(configured, 'TEAL_PERSISTENT_BRIDGE_SOURCE_ROOT');
  }
  try {
    const stat = await lstat(fallbackBridgeRoot);
    if (!stat.isDirectory()) return null;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
  return validateBridgeSourceRoot(fallbackBridgeRoot, 'The workspace sibling fallback');
}

async function copySafeFixtureFile(source, fixtureRoot, destination) {
  assert.ok(bridgeSource, 'The bridge source was not resolved before fixture creation.');
  await assertSafeRegularFile(bridgeSource.root, source, 'The bridge fixture source file');
  const target = expectContainedPath(fixtureRoot, destination, 'The bridge fixture copy target');
  await assertSafeDirectory(fixtureRoot, dirname(target), 'The bridge fixture copy parent');
  await assert.rejects(lstat(target), (cause) => cause?.code === 'ENOENT', 'The bridge fixture copy target already exists.');
  await cp(source, target);
  await assertSafeRegularFile(fixtureRoot, target, 'The copied bridge fixture file');
}

async function createSafeNodeModulesJunction(fixture) {
  assert.ok(bridgeSource, 'The bridge source was not resolved before fixture creation.');
  const target = expectContainedPath(fixture.root, join(fixture.root, 'node_modules'), 'The fixture dependency junction');
  await assert.rejects(lstat(target), (cause) => cause?.code === 'ENOENT', 'The fixture dependency junction target already exists.');
  await symlink(bridgeSource.nodeModules, target, 'junction');
  const stat = await lstat(target);
  assert.equal(stat.isSymbolicLink(), true, 'The fixture dependency junction was not a reparse link.');
  const linkedRealPath = await realpath(target);
  assert.equal(
    filesystemIdentity(linkedRealPath),
    filesystemIdentity(bridgeSource.nodeModulesReal),
    'The fixture dependency junction resolved outside the approved bridge dependency root.',
  );
  fixture.nodeModulesJunction = target;
}

async function verifySafeNodeModulesJunction(fixture) {
  if (!fixture?.nodeModulesJunction) return;
  const target = expectContainedPath(fixture.root, fixture.nodeModulesJunction, 'The fixture dependency junction during cleanup');
  const stat = await lstat(target);
  assert.equal(stat.isSymbolicLink(), true, 'The fixture dependency junction changed before cleanup.');
  const linkedRealPath = await realpath(target);
  assert.equal(
    filesystemIdentity(linkedRealPath),
    filesystemIdentity(bridgeSource.nodeModulesReal),
    'The fixture dependency junction changed its target before cleanup.',
  );
}

function pipeNames(root) {
  const rootHash = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 24);
  return {
    daemon: `\\\\.\\pipe\\dev-newb-chrome-daemon-${rootHash}`,
    lease: `\\\\.\\pipe\\dev-newb-chrome-control-${rootHash}`,
  };
}

function provePipeAbsent(path, timeoutMs = 750) {
  return new Promise((resolveProof, rejectProof) => {
    const socket = net.createConnection(path);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(rejectProof, new Error(`The test could not prove that its named pipe was free: ${path}`)), timeoutMs);
    socket.once('connect', () => finish(rejectProof, new Error(`The isolated test named pipe is already in use: ${path}`)));
    socket.once('error', (cause) => {
      if (cause?.code === 'ENOENT') finish(resolveProof);
      else finish(rejectProof, new Error(`The test could not prove that its named pipe was free (${cause?.code || 'unknown'}).`));
    });
  });
}

function processIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause?.code !== 'ESRCH'; }
}

async function waitForCondition(callback, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await callback()) return;
    await delay(40);
  }
  throw new Error(message);
}

async function createObservedLeaseOwner(fixture) {
  const sockets = new Set();
  let observed = false;
  let resolveContention;
  const contention = new Promise((resolveObserved) => { resolveContention = resolveObserved; });
  const status = {
    pid: process.pid,
    parent_pid: process.ppid,
    gateway_instance_id: randomBytes(16).toString('hex'),
    lease_instance_id: randomBytes(16).toString('hex'),
    acquired_at_utc: new Date().toISOString(),
    last_activity_at_utc: new Date().toISOString(),
    in_flight: true,
    queue_depth: 1,
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(1_000, () => socket.destroy());
    let buffer = '';
    let answered = false;
    socket.on('data', (chunk) => {
      if (answered) return;
      buffer += chunk;
      if (buffer.length > 4_096) {
        answered = true;
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      answered = true;
      const line = buffer.slice(0, newline).trim();
      if (buffer.slice(newline + 1).trim() || !line) {
        socket.destroy();
        return;
      }
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      const requestKeys = request && typeof request === 'object' && !Array.isArray(request)
        ? Object.keys(request).sort().join(',')
        : '';
      const exactStatusRequest = request
        && typeof request === 'object'
        && !Array.isArray(request)
        && requestKeys === 'operation,token'
        && request.operation === 'status'
        && request.token === fixture.token;
      const exactYieldRequest = request
        && typeof request === 'object'
        && !Array.isArray(request)
        && requestKeys === 'gateway_instance_id,lease_instance_id,operation,token'
        && request.operation === 'yield'
        && request.token === fixture.token
        && request.gateway_instance_id === status.gateway_instance_id
        && request.lease_instance_id === status.lease_instance_id;
      if (exactYieldRequest) {
        socket.end(`${JSON.stringify({
          operation: 'yield',
          accepted: false,
          gateway_instance_id: status.gateway_instance_id,
          lease_instance_id: status.lease_instance_id,
          reason: 'owner_busy',
        })}\n`);
        return;
      }
      if (!exactStatusRequest) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify(status)}\n`, () => {
        if (observed) return;
        observed = true;
        resolveContention({ request, status });
      });
    });
    socket.on('error', () => undefined);
  });
  await new Promise((resolveListen, rejectListen) => {
    const onError = (cause) => { server.removeListener('listening', onListening); rejectListen(cause); };
    const onListening = () => { server.removeListener('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(fixture.pipes.lease);
  });
  let closed = false;
  return {
    async waitForContention(timeoutMs = 5_000) {
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => rejectWait(new Error('The queued CLI did not present an authenticated lease status request.')), timeoutMs);
        contention.then((value) => {
          clearTimeout(timer);
          resolveWait(value);
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolveClose, rejectClose) => {
        server.close((cause) => cause ? rejectClose(cause) : resolveClose());
      });
      for (const socket of sockets) socket.destroy();
    },
  };
}

function runProcess(file, args, options = {}) {
  return new Promise((resolveRun) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs || 20_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: Number.isSafeInteger(error?.code) ? error.code : 0,
        signal: error?.signal || null,
        timedOut: error?.killed === true,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

function parseOneJsonLine(text, label) {
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `${label} did not emit exactly one JSON line.`);
  return JSON.parse(lines[0]);
}

async function daemonStatus(fixture) {
  const result = await runProcess(process.execPath, [join(fixture.root, 'runtime', 'daemon.mjs'), '--status'], {
    cwd: fixture.root,
    env: fixture.env,
    timeoutMs: 5_000,
  });
  assert.equal(result.timedOut, false, 'The isolated daemon status command timed out.');
  return { result, value: parseOneJsonLine(result.stdout, 'Daemon status') };
}

async function startDaemon(fixture) {
  const child = spawn(process.execPath, [join(fixture.root, 'runtime', 'daemon.mjs')], {
    cwd: fixture.root,
    env: fixture.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.daemon = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { fixture.daemonStdout += chunk; });
  child.stderr?.on('data', (chunk) => { fixture.daemonStderr += chunk; });
  await waitForCondition(async () => {
    if (child.exitCode !== null) throw new Error(`The isolated daemon exited during startup (${child.exitCode}). ${fixture.daemonStderr}`);
    try {
      const { value } = await daemonStatus(fixture);
      return value.status === 'running' && value.pid === child.pid;
    } catch {
      return false;
    }
  }, 8_000, `The isolated daemon did not become ready. ${fixture.daemonStderr}`);
}

async function createFixture(label, options = {}) {
  assert.ok(bridgeSource, 'The bridge source was not resolved before fixture creation.');
  const root = expectTempRoot(await mkdtemp(join(tmpdir(), tempPrefix)));
  const fixture = {
    label,
    root,
    daemon: null,
    daemonStdout: '',
    daemonStderr: '',
    pipes: pipeNames(root),
    token: randomBytes(32).toString('hex'),
  };
  try {
    await mkdir(join(root, 'runtime'), { recursive: true });
    for (const name of ['daemon.mjs', 'stdio-proxy.mjs', 'allow-remote-debugging.ps1', 'status.ps1']) {
      await copySafeFixtureFile(join(bridgeSource.runtime, name), root, join(root, 'runtime', name));
    }
    await createSafeNodeModulesJunction(fixture);
    await writeFile(join(root, 'install-state.json'), JSON.stringify({
      install_root: root,
      daemon_token: fixture.token,
      node_path: process.execPath,
    }), 'utf8');
    fixture.eventsPath = join(root, 'events.jsonl');
    fixture.modePath = join(root, 'mode.txt');
    fixture.failureMarker = join(root, 'apply-fill-failed.once');
    if (options.backend === 'bridge-fake') {
      fixture.backendPath = bridgeSource.fakeBackend;
    } else {
      fixture.backendPath = join(root, 'contract-fake-chrome.mjs');
      await writeFile(fixture.backendPath, contractBackendSource, 'utf8');
    }
    fixture.env = {
      ...process.env,
      NODE_ENV: 'test',
      CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND: '1',
      CHROME_DEVTOOLS_MCP_TEST_BACKEND: fixture.backendPath,
      CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS: '2000',
      FAKE_CHROME_EVENTS_FILE: fixture.eventsPath,
      TEAL_TEST_EVENTS_FILE: fixture.eventsPath,
      TEAL_TEST_MODE_FILE: fixture.modePath,
      TEAL_TEST_FAILURE_MARKER: fixture.failureMarker,
      ...(options.env || {}),
    };
    await provePipeAbsent(fixture.pipes.daemon);
    await provePipeAbsent(fixture.pipes.lease);
    if (options.startDaemon !== false) await startDaemon(fixture);
    return fixture;
  } catch (cause) {
    await closeFixture(fixture);
    throw cause;
  }
}

async function closeFixture(fixture) {
  if (!fixture) return;
  const child = fixture.daemon;
  if (child && child.exitCode === null) {
    const stop = await runProcess(process.execPath, [join(fixture.root, 'runtime', 'daemon.mjs'), '--stop'], {
      cwd: fixture.root,
      env: fixture.env,
      timeoutMs: 12_000,
    });
    if (stop.exitCode === 0 && stop.stdout.trim()) {
      const stopped = parseOneJsonLine(stop.stdout, 'Daemon stop');
      assert.equal(stopped.pid, child.pid, 'The stop command did not identify the test-owned daemon.');
    }
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
    assert.equal(processIsLive(child.pid), false, 'A test-owned daemon process remained live after cleanup.');
  }
  await verifySafeNodeModulesJunction(fixture);
  const guardedRoot = expectTempRoot(fixture.root);
  await rm(guardedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

class RawMcpSession {
  constructor(proxyPath, fixture) {
    this.child = spawn(process.execPath, [proxyPath, 'chrome-devtools', '--lease-wait-ms', '1000'], {
      cwd: fixture.root,
      env: fixture.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.once('exit', (code) => this.failPending(new Error(`The raw MCP proxy exited (${code ?? 'unknown'}). ${this.stderr}`)));
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!Object.hasOwn(message, 'id')) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  failPending(cause) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new Error(`The raw MCP request timed out during ${method}.`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async start() {
    const initialized = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'teal-cross-repo-test', version: '1.0.0' },
    });
    assert.equal(typeof initialized.protocolVersion, 'string', 'The real proxy did not initialize.');
    assert.equal(initialized.serverInfo?.name, 'chrome-devtools-persistent-gateway');
    assert.equal(initialized.serverInfo?.version, '0.1.3');
    this.notify('notifications/initialized', {});
    return this;
  }

  callTool(name, args = {}, timeoutMs = 15_000) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { }
    if (this.child.exitCode === null) await Promise.race([once(this.child, 'exit'), delay(2_000)]);
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([once(this.child, 'exit'), delay(2_000)]);
    }
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await Promise.race([once(this.child, 'exit'), delay(2_000)]);
    }
    assert.equal(processIsLive(this.child.pid), false, 'A test-owned raw proxy process remained live.');
  }
}

async function runCli(fixture, command) {
  const statePath = join(fixture.root, 'cli-state.json');
  const result = await runProcess(process.execPath, [
    cliPath,
    command,
    '--persistent-bridge', join(fixture.root, proxyRelativePath),
    '--bridge-wait-seconds', '1',
    '--issue', 'TAB-TEST',
    '--state', statePath,
  ], {
    cwd: publicRoot,
    env: fixture.env,
    timeoutMs: 30_000,
  });
  assert.equal(result.timedOut, false, `The public CLI ${command} command timed out.`);
  return { ...result, json: parseOneJsonLine(result.stdout, `Public CLI ${command}`) };
}

async function readEvents(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() ? text.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
  } catch (cause) {
    if (cause?.code === 'ENOENT') return [];
    throw cause;
  }
}

async function hashFile(path) {
  const value = await readFile(path);
  return createHash('sha256').update(value).digest('hex');
}

test('real bridge and public CLI keep isolated transport failures explicit', async (t) => {
  bridgeSource = await resolveBridgeSourceRoot();
  if (!bridgeSource) {
    t.skip('The bridge source is unavailable. Set TEAL_PERSISTENT_BRIDGE_SOURCE_ROOT to an absolute local bridge source directory to run this cross-repository suite.');
    return;
  }
  if (bridgeSource.version !== '0.1.3') {
    t.skip(`The available bridge is ${bridgeSource.version || 'unversioned'}; this release requires bridge 0.1.3.`);
    return;
  }
  const watchedFiles = [
    join(publicRoot, 'extension', 'persistent-mcp-client.mjs'),
    cliPath,
    join(bridgeSource.runtime, 'daemon.mjs'),
    join(bridgeSource.runtime, 'stdio-proxy.mjs'),
    bridgeSource.fakeBackend,
    bridgeSource.packagePath,
  ];
  for (const path of [...watchedFiles, bridgeSource.nodeModules]) {
    const stat = await lstat(path);
    assert.ok(path === bridgeSource.nodeModules ? stat.isDirectory() : stat.isFile(), `A required cross-repository test input is missing: ${path}`);
  }
  const beforeHashes = await Promise.all(watchedFiles.map(hashFile));

  await t.test('real daemon and proxy reach the exact bridge fake backend for read-only status and list', async () => {
    const fixture = await createFixture('exact-fake', { backend: 'bridge-fake' });
    let session;
    try {
      const status = await daemonStatus(fixture);
      assert.equal(status.result.exitCode, 0);
      assert.equal(status.value.status, 'running');
      assert.equal(status.value.pid, fixture.daemon.pid);
      assert.equal(status.value.lease?.state, 'free');

      session = await new RawMcpSession(join(fixture.root, proxyRelativePath), fixture).start();
      const manifest = await session.request('tools/list', {});
      assert.equal(manifest.tools.length, 30, 'The real proxy did not return its full reviewed manifest.');
      const pages = await session.callTool('list_pages', {});
      assert.notEqual(pages.isError, true, 'The exact bridge fake backend did not complete list_pages.');
      const fakeBackendResult = JSON.parse(pages.content?.[0]?.text || 'null');
      assert.deepEqual(fakeBackendResult, { ok: true, name: 'list_pages', args: {} });
    } finally {
      await session?.close();
      await closeFixture(fixture);
    }
  });

  await t.test('public CLI status and list complete through the real daemon and proxy', async () => {
    const fixture = await createFixture('cli-read-only');
    try {
      for (const command of ['status', 'list']) {
        const run = await runCli(fixture, command);
        assert.equal(run.exitCode, 0, `${command} did not return exit code 0. ${run.stderr}`);
        assert.equal(run.json.ok, true);
        assert.equal(run.json.command, command);
        assert.equal(run.json.operation, command);
        assert.equal(run.json.issueIdentifier, 'TAB-TEST');
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  await t.test('a queued CLI agent proceeds after observed authenticated contention and owner release', async () => {
    const fixture = await createFixture('cooperative-wait');
    let owner;
    try {
      owner = await createObservedLeaseOwner(fixture);
      const queued = runCli(fixture, 'status');
      const contention = await owner.waitForContention();
      assert.deepEqual(Object.keys(contention.request).sort(), ['operation', 'token']);
      assert.equal(contention.request.operation, 'status');
      assert.equal(contention.request.token === fixture.token, true, 'The queued CLI did not authenticate its lease status request.');
      assert.equal(contention.status.pid, process.pid);
      assert.equal(contention.status.parent_pid, process.ppid);
      assert.equal(typeof contention.status.lease_instance_id, 'string');
      assert.equal(contention.status.in_flight, true);
      assert.equal(contention.status.queue_depth, 1);
      assert.deepEqual(await readEvents(fixture.eventsPath), [], 'The queued CLI dispatched Chrome work before the held lease was released.');
      await owner.close();
      owner = null;
      const run = await queued;
      assert.equal(run.exitCode, 0, `Queued CLI returned ${run.exitCode}. ${run.stderr}`);
      assert.equal(run.json.ok, true);
    } finally {
      await owner?.close();
      await closeFixture(fixture);
    }
  });

  await t.test('known authenticated lease owner facts reach sanitized CLI JSON without contradiction', async () => {
    const fixture = await createFixture('lease-owner', {
      env: {
        TEAL_TEST_DELAY_TOOL: 'take_snapshot',
        TEAL_TEST_DELAY_MS: '5000',
      },
    });
    let owner;
    let activeOwnerCall;
    try {
      owner = await McpStdioSession.open(join(fixture.root, proxyRelativePath));
      const listed = await owner.callTool('list_pages', {});
      assert.equal(listed.structuredContent?.pages?.length, 1);
      const selected = await owner.callTool('select_page', { pageId: 1, bringToFront: false });
      assert.equal(selected.structuredContent?.selectedPageId, 1);
      activeOwnerCall = owner.callTool('take_snapshot', {});
      await waitForCondition(async () => {
        const lease = (await daemonStatus(fixture)).value.lease;
        const events = await readEvents(fixture.eventsPath);
        return lease?.state === 'held'
          && lease.in_flight === true
          && events.some((event) => event.name === 'take_snapshot');
      }, 2_000, 'The known lease owner did not enter its delayed backend call.');
      const ownerPid = owner.child.pid;
      const held = (await daemonStatus(fixture)).value.lease;
      assert.equal(held?.state, 'held');
      assert.equal(held.pid, ownerPid);
      assert.equal(held.parent_pid, process.pid);
      assert.equal(held.in_flight, true);
      assert.equal(held.queue_depth, 0);

      const run = await runCli(fixture, 'status');
      assert.equal(run.exitCode, 3, `Busy CLI returned ${run.exitCode}. ${run.stderr}`);
      assert.equal(run.json.ok, false);
      assert.equal(run.json.errorKind, 'lease_busy');
      assert.equal(run.json.bridgeStatus, 'lease_busy');
      assert.equal(run.json.errorData?.owner_pid, ownerPid);
      assert.equal(run.json.errorData?.owner_parent_pid, process.pid);
      assert.equal(run.json.errorData?.owner_gateway_instance_id, held.gateway_instance_id);
      assert.equal(run.json.errorData?.dispatched, false);
      assert.equal(run.json.errorData?.automatic_retry_allowed, false);
      assert.notEqual(run.json.leaseOwner, 'unknown', 'The CLI contradicted its authenticated known-owner facts.');
      assert.doesNotMatch(run.json.error, /owner is unknown/iu);
      const serialized = JSON.stringify(run.json);
      assert.equal(serialized.includes(fixture.token), false, 'The CLI JSON exposed the daemon token.');
      assert.equal(serialized.includes('dev-newb-chrome-control-'), false, 'The CLI JSON exposed the lease pipe name.');
      const completedOwnerCall = await activeOwnerCall;
      activeOwnerCall = null;
      assert.notEqual(completedOwnerCall.isError, true, 'The delayed owner tool did not complete after the contention check.');
    } finally {
      await activeOwnerCall?.catch(() => undefined);
      await owner?.close();
      await closeFixture(fixture);
    }
  });

  await t.test('absent real daemon stays daemon_absent through the public CLI', async () => {
    const fixture = await createFixture('daemon-absent', { startDaemon: false });
    try {
      const run = await runCli(fixture, 'status');
      assert.equal(run.exitCode, 3, `Absent-daemon CLI returned ${run.exitCode}. ${run.stderr}`);
      assert.equal(run.json.ok, false);
      assert.equal(run.json.errorKind, 'daemon_absent');
      assert.equal(run.json.bridgeStatus, 'daemon_absent');
      assert.notEqual(run.json.errorKind, 'proxy_lifecycle');
      const serialized = JSON.stringify(run.json);
      assert.equal(serialized.includes(fixture.token), false, 'The absent-daemon result exposed the daemon token.');
      assert.equal(serialized.includes('dev-newb-chrome-daemon-'), false, 'The absent-daemon result exposed the daemon pipe name.');
      await provePipeAbsent(fixture.pipes.daemon);
      await provePipeAbsent(fixture.pipes.lease);
    } finally {
      await closeFixture(fixture);
    }
  });

  await t.test('an uncertain dispatched apply is not sent a second time', async () => {
    const fixture = await createFixture('apply-no-retry');
    let client;
    try {
      client = await new PersistentBridgeClient(join(fixture.root, proxyRelativePath), 'TAB-TEST').attach();
      await writeFile(fixture.modePath, 'fail-next-apply-fill\n', 'utf8');
      const started = Date.now();
      await assert.rejects(
        client.callBridge({ command: 'apply-delete', token: 'fictional-local-test-token' }, { timeoutMs: 2_000 }),
        (error) => error?.indeterminate === true && /apply dispatch is indeterminate/iu.test(error.message),
      );
      assert.ok(Date.now() - started < 20_000, 'The uncertain apply did not fail closed promptly.');
      await delay(300);
      const applyFills = (await readEvents(fixture.eventsPath))
        .filter((event) => event.name === 'fill' && event.command?.command === 'apply-delete');
      assert.equal(applyFills.length, 1, 'The public persistent client replayed the uncertain apply fill.');
      assert.equal((await lstat(fixture.failureMarker)).isFile(), true, 'The fake backend did not prove a post-dispatch failure.');
    } finally {
      await client?.close();
      await closeFixture(fixture);
    }
  });

  const afterHashes = await Promise.all(watchedFiles.map(hashFile));
  assert.deepEqual(afterHashes, beforeHashes, 'A production input changed while the cross-repository test was running.');
});
