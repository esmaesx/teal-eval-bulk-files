/* global Blob, TextEncoder */
/*
 * Dependency-free ZIP32 writer for the extension isolated world.
 * It creates only stored (uncompressed) entries.
 */
(function installTealEvalZip(global) {
  "use strict";

  var MAX_U16 = 0xffff;
  var MAX_U32 = 0xffffffff;
  var UTF8_FLAG = 0x0800;
  var STORE_METHOD = 0;
  var LOCAL_FILE_HEADER_SIZE = 30;
  var CENTRAL_DIRECTORY_HEADER_SIZE = 46;
  var EOCD_SIZE = 22;
  var encoder = new TextEncoder();
  var crcTable = makeCrcTable();
  var sha256Constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function makeCrcTable() {
    var table = new Uint32Array(256);
    var value;
    var index;
    var bit;

    for (index = 0; index < 256; index += 1) {
      value = index;
      for (bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function updateCrc32(crc, bytes) {
    var next = crc;
    var index;
    for (index = 0; index < bytes.length; index += 1) {
      next = (next >>> 8) ^ crcTable[(next ^ bytes[index]) & 0xff];
    }
    return next >>> 0;
  }

  function writeU16(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function isBlobLike(value) {
    return value !== null && typeof value === "object" &&
      typeof value.size === "number" && typeof value.stream === "function";
  }

  function fail(message) {
    throw new Error("ZIP builder: " + message);
  }

  function assertZip32Number(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_U32) {
      fail(label + " must be below 0xffffffff for ZIP32.");
    }
  }

  function safeAddZip32(left, right, label) {
    var total = left + right;
    assertZip32Number(total, label);
    return total;
  }

  function validateName(name) {
    if (typeof name !== "string" || name.length === 0) {
      fail("each entry name must be a non-empty basename string.");
    }
    if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f-\u009f]/.test(name)) {
      fail("unsafe ZIP entry name: " + JSON.stringify(name) + ".");
    }
  }

  function toDosDateTime(value) {
    var date;
    var milliseconds;

    if (value === undefined) {
      date = new Date();
    } else if (value instanceof Date) {
      milliseconds = value.getTime();
      if (!Number.isFinite(milliseconds)) {
        fail("lastModified Date is invalid.");
      }
      date = new Date(milliseconds);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      date = new Date(value);
    } else {
      fail("lastModified must be a Date or a millisecond timestamp.");
    }

    if (date.getFullYear() < 1980) {
      date = new Date(1980, 0, 1, 0, 0, 0, 0);
    } else if (date.getFullYear() > 2107) {
      date = new Date(2107, 11, 31, 23, 59, 58, 0);
    }

    return {
      date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    };
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    fail("Blob stream returned a non-binary chunk.");
  }

  function validateHashBlob(blob) {
    if (!isBlobLike(blob) || !Number.isSafeInteger(blob.size) || blob.size < 0) {
      fail("sha256 requires a Blob with a valid size and stream().");
    }
  }

  function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  function makeSha256State() {
    return {
      buffer: new Uint8Array(64),
      bufferLength: 0,
      hash: new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
      ]),
      lengthHigh: 0,
      lengthLow: 0,
      words: new Uint32Array(64)
    };
  }

  function addSha256Length(state, byteLength) {
    var lowPart = byteLength >>> 0;
    var highPart = Math.floor(byteLength / 0x100000000);
    var low = (state.lengthLow + lowPart) >>> 0;
    if (low < state.lengthLow) {
      highPart += 1;
    }
    state.lengthHigh = (state.lengthHigh + highPart) >>> 0;
    state.lengthLow = low;
  }

  function processSha256Block(state, bytes, offset) {
    var words = state.words;
    var hash = state.hash;
    var a = hash[0];
    var b = hash[1];
    var c = hash[2];
    var d = hash[3];
    var e = hash[4];
    var f = hash[5];
    var g = hash[6];
    var h = hash[7];
    var index;
    var sigma0;
    var sigma1;
    var choose;
    var majority;
    var temporary1;
    var temporary2;

    for (index = 0; index < 16; index += 1) {
      words[index] = ((bytes[offset + (index * 4)] << 24) |
        (bytes[offset + (index * 4) + 1] << 16) |
        (bytes[offset + (index * 4) + 2] << 8) |
        bytes[offset + (index * 4) + 3]) >>> 0;
    }
    for (index = 16; index < 64; index += 1) {
      sigma0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      sigma1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    for (index = 0; index < 64; index += 1) {
      sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      choose = (e & f) ^ ((~e) & g);
      temporary1 = (h + sigma1 + choose + sha256Constants[index] + words[index]) >>> 0;
      sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      majority = (a & b) ^ (a & c) ^ (b & c);
      temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  function updateSha256(state, bytes) {
    var offset = 0;
    var copied;

    addSha256Length(state, bytes.length);
    while (offset < bytes.length) {
      if (state.bufferLength === 0 && bytes.length - offset >= 64) {
        processSha256Block(state, bytes, offset);
        offset += 64;
      } else {
        copied = Math.min(64 - state.bufferLength, bytes.length - offset);
        state.buffer.set(bytes.subarray(offset, offset + copied), state.bufferLength);
        state.bufferLength += copied;
        offset += copied;
        if (state.bufferLength === 64) {
          processSha256Block(state, state.buffer, 0);
          state.bufferLength = 0;
        }
      }
    }
  }

  function finishSha256(state) {
    var buffer = state.buffer;
    var index;
    var bitHigh = ((state.lengthHigh << 3) | (state.lengthLow >>> 29)) >>> 0;
    var bitLow = (state.lengthLow << 3) >>> 0;
    var hex = "";

    buffer[state.bufferLength] = 0x80;
    state.bufferLength += 1;
    if (state.bufferLength > 56) {
      for (index = state.bufferLength; index < 64; index += 1) {
        buffer[index] = 0;
      }
      processSha256Block(state, buffer, 0);
      state.bufferLength = 0;
    }
    for (index = state.bufferLength; index < 56; index += 1) {
      buffer[index] = 0;
    }
    writeU32BigEndian(buffer, 56, bitHigh);
    writeU32BigEndian(buffer, 60, bitLow);
    processSha256Block(state, buffer, 0);
    for (index = 0; index < state.hash.length; index += 1) {
      hex += ("00000000" + state.hash[index].toString(16)).slice(-8);
    }
    return hex;
  }

  function writeU32BigEndian(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }

  async function sha256(blob, options) {
    var settings = options === undefined ? {} : options;
    var onProgress;
    var stream;
    var reader;
    var result;
    var bytes;
    var state;
    var completedBytes = 0;
    var reported = false;

    validateHashBlob(blob);
    if (settings === null || typeof settings !== "object") {
      fail("sha256 options must be an object when provided.");
    }
    onProgress = settings.onProgress;
    if (onProgress !== undefined && typeof onProgress !== "function") {
      fail("sha256 options.onProgress must be a function when provided.");
    }

    stream = blob.stream();
    if (!stream || typeof stream.getReader !== "function") {
      fail("Blob.stream() did not return a readable stream.");
    }
    state = makeSha256State();
    reader = stream.getReader();
    try {
      for (;;) {
        result = await reader.read();
        if (result.done) {
          break;
        }
        bytes = asBytes(result.value);
        updateSha256(state, bytes);
        completedBytes += bytes.length;
        reported = true;
        if (onProgress) {
          onProgress({ completedBytes: completedBytes, totalBytes: blob.size });
        }
      }
    } finally {
      if (reader) {
        reader.releaseLock();
      }
    }
    if (onProgress && !reported) {
      onProgress({ completedBytes: 0, totalBytes: blob.size });
    }
    return finishSha256(state);
  }

  async function calculateCrc32(blob, reportProgress) {
    var crc = 0xffffffff;
    var stream;
    var reader;
    var result;
    var bytes;

    stream = blob.stream();
    if (!stream || typeof stream.getReader !== "function") {
      fail("Blob.stream() did not return a readable stream.");
    }
    reader = stream.getReader();
    try {
      for (;;) {
        result = await reader.read();
        if (result.done) {
          break;
        }
        bytes = asBytes(result.value);
        crc = updateCrc32(crc, bytes);
        reportProgress(bytes.length);
      }
    } finally {
      if (reader) {
        reader.releaseLock();
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeLocalHeader(record) {
    var header = new Uint8Array(LOCAL_FILE_HEADER_SIZE + record.nameBytes.length);
    writeU32(header, 0, 0x04034b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, UTF8_FLAG);
    writeU16(header, 8, STORE_METHOD);
    writeU16(header, 10, record.dosTime);
    writeU16(header, 12, record.dosDate);
    writeU32(header, 14, record.crc32);
    writeU32(header, 18, record.size);
    writeU32(header, 22, record.size);
    writeU16(header, 26, record.nameBytes.length);
    writeU16(header, 28, 0);
    header.set(record.nameBytes, LOCAL_FILE_HEADER_SIZE);
    return header;
  }

  function makeCentralDirectoryHeader(record) {
    var header = new Uint8Array(CENTRAL_DIRECTORY_HEADER_SIZE + record.nameBytes.length);
    writeU32(header, 0, 0x02014b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, 20);
    writeU16(header, 8, UTF8_FLAG);
    writeU16(header, 10, STORE_METHOD);
    writeU16(header, 12, record.dosTime);
    writeU16(header, 14, record.dosDate);
    writeU32(header, 16, record.crc32);
    writeU32(header, 20, record.size);
    writeU32(header, 24, record.size);
    writeU16(header, 28, record.nameBytes.length);
    writeU16(header, 30, 0);
    writeU16(header, 32, 0);
    writeU16(header, 34, 0);
    writeU16(header, 36, 0);
    writeU32(header, 38, 0);
    writeU32(header, 42, record.localOffset);
    header.set(record.nameBytes, CENTRAL_DIRECTORY_HEADER_SIZE);
    return header;
  }

  function makeEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
    var eocd = new Uint8Array(EOCD_SIZE);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, entryCount);
    writeU16(eocd, 10, entryCount);
    writeU32(eocd, 12, centralDirectorySize);
    writeU32(eocd, 16, centralDirectoryOffset);
    writeU16(eocd, 20, 0);
    return eocd;
  }

  function prepareRecords(entries) {
    var names = new Set();
    var records = [];
    var totalBytes = 0;
    var localOffset = 0;
    var centralDirectorySize = 0;
    var index;
    var entry;
    var nameBytes;
    var dosDateTime;
    var record;

    if (!Array.isArray(entries)) {
      fail("entries must be an ordered array.");
    }
    if (entries.length >= MAX_U16) {
      fail("entry count must be below 65535 for ZIP32.");
    }

    for (index = 0; index < entries.length; index += 1) {
      entry = entries[index];
      if (entry === null || typeof entry !== "object") {
        fail("entry " + index + " must be an object.");
      }
      validateName(entry.name);
      if (names.has(entry.name)) {
        fail("duplicate ZIP entry name: " + JSON.stringify(entry.name) + ".");
      }
      names.add(entry.name);

      if (!isBlobLike(entry.blob)) {
        fail("entry " + index + " must include a Blob.");
      }
      assertZip32Number(entry.blob.size, "entry " + index + " size");

      nameBytes = encoder.encode(entry.name);
      if (nameBytes.length > MAX_U16) {
        fail("UTF-8 entry name is longer than 65535 bytes: " + JSON.stringify(entry.name) + ".");
      }

      dosDateTime = toDosDateTime(entry.lastModified);
      record = {
        blob: entry.blob,
        dosDate: dosDateTime.date,
        dosTime: dosDateTime.time,
        index: index,
        localOffset: localOffset,
        name: entry.name,
        nameBytes: nameBytes,
        size: entry.blob.size
      };
      localOffset = safeAddZip32(localOffset, LOCAL_FILE_HEADER_SIZE + nameBytes.length, "local header offset");
      localOffset = safeAddZip32(localOffset, record.size, "local data offset");
      centralDirectorySize = safeAddZip32(
        centralDirectorySize,
        CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length,
        "central directory size"
      );
      totalBytes += record.size;
      records.push(record);
    }

    assertZip32Number(localOffset, "central directory offset");
    assertZip32Number(centralDirectorySize, "central directory size");
    assertZip32Number(
      safeAddZip32(localOffset, centralDirectorySize, "end of central directory offset"),
      "end of central directory offset"
    );

    return {
      centralDirectoryOffset: localOffset,
      centralDirectorySize: centralDirectorySize,
      records: records,
      totalBytes: totalBytes
    };
  }

  async function build(entries, options) {
    var settings = options === undefined ? {} : options;
    var onProgress;
    var prepared;
    var records;
    var localParts = [];
    var centralDirectoryParts = [];
    var completedBytes = 0;
    var index;
    var record;
    var reportedForEmptyBlob;

    if (settings === null || typeof settings !== "object") {
      fail("options must be an object when provided.");
    }
    onProgress = settings.onProgress;
    if (onProgress !== undefined && typeof onProgress !== "function") {
      fail("options.onProgress must be a function when provided.");
    }

    prepared = prepareRecords(entries);
    records = prepared.records;

    for (index = 0; index < records.length; index += 1) {
      record = records[index];
      reportedForEmptyBlob = false;
      record.crc32 = await calculateCrc32(record.blob, function reportChunk(chunkSize) {
        completedBytes += chunkSize;
        reportedForEmptyBlob = true;
        if (onProgress) {
          onProgress({
            completedBytes: completedBytes,
            fileCount: records.length,
            fileIndex: record.index,
            fileSize: record.size,
            name: record.name,
            totalBytes: prepared.totalBytes
          });
        }
      });
      if (onProgress && !reportedForEmptyBlob) {
        onProgress({
          completedBytes: completedBytes,
          fileCount: records.length,
          fileIndex: record.index,
          fileSize: record.size,
          name: record.name,
          totalBytes: prepared.totalBytes
        });
      }
      localParts.push(makeLocalHeader(record), record.blob);
      centralDirectoryParts.push(makeCentralDirectoryHeader(record));
    }

    localParts.push.apply(localParts, centralDirectoryParts);
    localParts.push(makeEndOfCentralDirectory(
      records.length,
      prepared.centralDirectorySize,
      prepared.centralDirectoryOffset
    ));
    return new Blob(localParts, { type: "application/zip" });
  }

  var api = Object.freeze({ build: build, sha256: sha256 });
  Object.defineProperty(global, "TealEvalZip", {
    configurable: false,
    enumerable: false,
    value: api,
    writable: false
  });
}(typeof globalThis === "object" ? globalThis : this));
