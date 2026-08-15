"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const vm = require("node:vm");

const builderPath = path.resolve(__dirname, "..", "extension", "zip-builder.js");
vm.runInThisContext(fs.readFileSync(builderPath, "utf8"), { filename: builderPath });

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseStoredZip(bytes) {
  const decoder = new TextDecoder();
  const files = [];
  let offset = 0;

  while (readU32(bytes, offset) === 0x04034b50) {
    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    const checksum = readU32(bytes, offset + 14);
    const compressedSize = readU32(bytes, offset + 18);
    const uncompressedSize = readU32(bytes, offset + 22);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    const data = bytes.slice(dataStart, dataStart + compressedSize);

    assert.equal(flags & 0x0800, 0x0800, "local header sets the UTF-8 bit");
    assert.equal(method, 0, "local header uses stored data");
    assert.equal(compressedSize, uncompressedSize, "stored sizes match");
    assert.equal(checksum, crc32(data), "local header CRC matches data");
    files.push({ data, name, offset });
    offset = dataStart + compressedSize;
  }

  const centralDirectoryOffset = offset;
  for (const file of files) {
    assert.equal(readU32(bytes, offset), 0x02014b50, "central directory header exists");
    assert.equal(readU16(bytes, offset + 8) & 0x0800, 0x0800, "central header sets the UTF-8 bit");
    assert.equal(readU16(bytes, offset + 10), 0, "central header uses stored data");
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    assert.equal(name, file.name, "central and local names match");
    assert.equal(readU32(bytes, offset + 42), file.offset, "central header points to local header");
    offset += 46 + nameLength + extraLength + commentLength;
  }

  assert.equal(readU32(bytes, offset), 0x06054b50, "end-of-central-directory exists");
  assert.equal(readU16(bytes, offset + 8), files.length, "EOCD records the file count");
  assert.equal(readU16(bytes, offset + 10), files.length, "EOCD records the file count twice");
  assert.equal(readU32(bytes, offset + 12), offset - centralDirectoryOffset, "EOCD records the central directory size");
  assert.equal(readU32(bytes, offset + 16), centralDirectoryOffset, "EOCD points to the central directory");
  assert.equal(offset + 22, bytes.length, "archive has no trailing data");
  return files;
}

async function expectReject(action, expectedMessage) {
  await assert.rejects(action, new RegExp(expectedMessage));
}

function nodeSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function testSha256() {
  const encoder = new TextEncoder();
  const multiChunkBytes = new Uint8Array(196731);
  for (let index = 0; index < multiChunkBytes.length; index += 1) {
    multiChunkBytes[index] = index % 251;
  }
  const multiChunkBlob = new Blob([multiChunkBytes]);
  Object.defineProperty(multiChunkBlob, "stream", {
    value() {
      let offset = 0;
      return new ReadableStream({
        pull(controller) {
          if (offset >= multiChunkBytes.length) {
            controller.close();
            return;
          }
          const next = Math.min(offset + 16384, multiChunkBytes.length);
          controller.enqueue(multiChunkBytes.slice(offset, next));
          offset = next;
        }
      });
    }
  });
  const fixtures = [
    {
      bytes: new Uint8Array(),
      expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      name: "NIST empty"
    },
    {
      bytes: encoder.encode("abc"),
      expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      name: "NIST abc"
    },
    {
      bytes: encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      name: "NIST 56-byte"
    },
    {
      bytes: encoder.encode("caf\u00e9 \ud83d\ude00"),
      expected: null,
      name: "Unicode UTF-8"
    },
    {
      blob: multiChunkBlob,
      bytes: multiChunkBytes,
      expected: null,
      name: "multi-chunk"
    }
  ];

  for (const fixture of fixtures) {
    const progress = [];
    const actual = await globalThis.TealEvalZip.sha256(
      fixture.blob || new Blob([fixture.bytes]),
      { onProgress: (event) => progress.push(event) }
    );
    const nodeDigest = nodeSha256(fixture.bytes);
    assert.equal(actual, nodeDigest, `${fixture.name} matches Node crypto`);
    if (fixture.expected) {
      assert.equal(actual, fixture.expected, `${fixture.name} matches its known SHA-256 vector`);
    }
    assert.match(actual, /^[0-9a-f]{64}$/, `${fixture.name} is lowercase hexadecimal`);
    assert.ok(progress.length >= 1, `${fixture.name} reports progress`);
    assert.equal(progress.at(-1).completedBytes, fixture.bytes.length, `${fixture.name} reaches full progress`);
    assert.equal(progress.at(-1).totalBytes, fixture.bytes.length, `${fixture.name} reports total bytes`);
    if (fixture.name === "multi-chunk") {
      assert.ok(progress.length > 1, "multi-chunk Blob streams more than one chunk");
    }
  }

  await expectReject(() => globalThis.TealEvalZip.sha256(null), "requires a Blob");
  await expectReject(
    () => globalThis.TealEvalZip.sha256(new Blob(["abc"]), { onProgress: true }),
    "onProgress must be a function"
  );
}

async function test() {
  await testSha256();
  const fixtures = [
    { name: "alpha.txt", bytes: new TextEncoder().encode("alpha\\n") },
    { name: "café-😀.txt", bytes: new TextEncoder().encode("café 😀\\n") },
    { name: "binary.dat", bytes: Uint8Array.from([0, 1, 2, 253, 254, 255]) },
    { name: "empty.txt", bytes: new Uint8Array() }
  ];
  const progress = [];
  const zip = await globalThis.TealEvalZip.build(
    fixtures.map((fixture) => ({
      name: fixture.name,
      blob: new Blob([fixture.bytes]),
      lastModified: Date.UTC(2026, 7, 14, 9, 30, 12)
    })),
    { onProgress: (event) => progress.push(event) }
  );
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const files = parseStoredZip(bytes);
  const modified = new Date(Date.UTC(2026, 7, 14, 9, 30, 12));
  const expectedDosDate = ((modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const expectedDosTime = (modified.getHours() << 11) | (modified.getMinutes() << 5) | Math.floor(modified.getSeconds() / 2);

  assert.equal(zip.type, "application/zip");
  assert.equal(files.length, fixtures.length);
  assert.equal(readU16(bytes, 10), expectedDosTime, "local header records the DOS time");
  assert.equal(readU16(bytes, 12), expectedDosDate, "local header records the DOS date");
  for (let index = 0; index < fixtures.length; index += 1) {
    assert.equal(files[index].name, fixtures[index].name);
    assert.deepEqual(files[index].data, fixtures[index].bytes);
  }
  assert.ok(progress.length >= fixtures.length, "progress reports each file, including empty files");
  assert.equal(progress.at(-1).completedBytes, fixtures.reduce((total, item) => total + item.bytes.length, 0));
  assert.equal(progress.at(-1).totalBytes, progress.at(-1).completedBytes);
  assert.ok(Object.isFrozen(globalThis.TealEvalZip), "public API is frozen");
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, "TealEvalZip").writable, false, "global is read-only");
  assert.equal(typeof globalThis.TealEvalZip.sha256, "function", "public API exposes sha256");

  await expectReject(
    () => globalThis.TealEvalZip.build([{ name: "../bad.txt", blob: new Blob(["x"]) }]),
    "unsafe ZIP entry name"
  );
  await expectReject(
    () => globalThis.TealEvalZip.build([
      { name: "same.txt", blob: new Blob(["one"]) },
      { name: "same.txt", blob: new Blob(["two"]) }
    ]),
    "duplicate ZIP entry name"
  );
  await expectReject(
    () => globalThis.TealEvalZip.build([{ name: "large.bin", blob: { size: 0xffffffff, stream() {} } }]),
    "below 0xffffffff"
  );

  const candidates = process.platform === "win32"
    ? [
      "7z.exe",
      "7zz.exe",
      "7za.exe",
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe"
    ]
    : ["7zz", "7z", "7za"];
  const sevenZip = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ["-h"], { encoding: "utf8", windowsHide: true });
    return !probe.error;
  });
  if (sevenZip) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "teal-eval-zip-"));
    try {
      const archivePath = path.join(temporaryDirectory, "four-files.zip");
      fs.writeFileSync(archivePath, bytes);
      const result = spawnSync(sevenZip, ["t", archivePath], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, `${sevenZip} verification failed: ${result.stderr || result.stdout}`);
      console.log(`${sevenZip} verified the ZIP archive.`);
    } finally {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  } else {
    console.log("7-Zip is not available; ran internal ZIP structure checks.");
  }
}

test().then(
  () => console.log("zip-builder test passed."),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
