// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Measures how much memory the server holds while it takes parallel uploads,
 * and while it builds a ZIP archive. Run by `upload-spool-memory.test.js`, and
 * by hand for the numbers in `docs/storage.md`:
 *
 *   node --expose-gc server/tests/support/uploadMemoryProbe.js
 *
 * Environment:
 * - `PROBE_MODES`: comma list of
 *   - `spool`: N parallel multipart uploads through the spool (the code path in use);
 *   - `memory`: the same uploads through `multer.memoryStorage()` and a Buffer handed to
 *     the ingest, without an extraction cap: the code path before the spool;
 *   - `zip-file`: an archive built into a spool file, members read as streams;
 *   - `zip-buffer`: the same archive built in memory from members read whole: the code
 *     path before the spool.
 * - `PROBE_UPLOADS` (20), `PROBE_UPLOAD_BYTES` (25 MiB): the uploads.
 * - `PROBE_ZIP_BYTES` (100 MiB), `PROBE_ZIP_MEMBERS` (10): the archive.
 * - `PROBE_CONCURRENCY`: `uploads.extraction.concurrency` of the `spool` mode (the default).
 *
 * What is measured: `process.memoryUsage().arrayBuffers` (where every Buffer of
 * the main thread lives) and `rss` (the whole process, extraction thread
 * included), sampled every 150 ms (`PROBE_SAMPLE_MS`) after a forced garbage collection. The result
 * is the highest sample minus the sample before the operation started.
 *
 * The client streams a generated body and holds no payload, so what is
 * measured is the server's side. Prints one JSON object.
 */
import './scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FilesystemStorageProvider } from '../../storage/index.js';
import { ChatFileRepository } from '../../services/chatFiles/ChatFileRepository.js';
import { normalizeChatFilePolicy } from '../../services/chatFiles/chatFilePolicy.js';
import {
  ExtractionLimiter,
  setExtractionLimiter
} from '../../services/uploads/extractionLimiter.js';
import { zipToBuffer, zipToFile } from '../../services/artifacts/artifactZip.js';
import { startUploadApp, streamUpload } from './uploadTestApp.js';

const MIB = 1024 * 1024;
const MODES = (process.env.PROBE_MODES || 'spool,memory').split(',');
const UPLOADS = Number(process.env.PROBE_UPLOADS || 20);
const UPLOAD_BYTES = Number(process.env.PROBE_UPLOAD_BYTES || 25 * MIB);
const ZIP_BYTES = Number(process.env.PROBE_ZIP_BYTES || 100 * MIB);
const ZIP_MEMBERS = Number(process.env.PROBE_ZIP_MEMBERS || 10);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 0);
// A forced collection takes tens of milliseconds: sampled more often, the probe measures itself.
const SAMPLE_MS = Number(process.env.PROBE_SAMPLE_MS || 150);

if (typeof globalThis.gc !== 'function') {
  console.error('Run this probe with node --expose-gc');
  process.exit(2);
}

/** Runs `work` and reports the peak growth of held memory while it ran. */
async function measured(work) {
  for (let round = 0; round < 5; round += 1) {
    globalThis.gc();
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const read = () => {
    globalThis.gc();
    const usage = process.memoryUsage();
    return { arrayBuffers: usage.arrayBuffers, rss: usage.rss };
  };
  const before = read();
  const peak = { ...before };
  const sample = () => {
    const now = read();
    peak.arrayBuffers = Math.max(peak.arrayBuffers, now.arrayBuffers);
    peak.rss = Math.max(peak.rss, now.rss);
  };
  const startedAt = performance.now();
  const timer = setInterval(sample, SAMPLE_MS);
  let value;
  try {
    value = await work();
  } finally {
    clearInterval(timer);
  }
  sample();
  return {
    value,
    peakArrayBuffers: peak.arrayBuffers - before.arrayBuffers,
    peakRss: peak.rss - before.rss,
    ms: Math.round(performance.now() - startedAt)
  };
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-upload-probe-'));
const provider = new FilesystemStorageProvider({ baseDir: path.join(scratch, 'storage') });
await provider.initialize();
const result = {};

/** N parallel uploads of one mode; every one must be stored with the right hash and size. */
async function uploads(mode) {
  const store = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  const policy = normalizeChatFilePolicy({
    enabled: true,
    storageMode: 'original_and_text',
    quotas: { maxFileBytes: UPLOAD_BYTES, maxChatBytes: 0, maxUserBytes: 0, maxServerBytes: 0 }
  });
  let counter = 0;
  // The code path before the spool had no cap: every upload was read at once.
  const uncapped = new ExtractionLimiter({
    limits: () => ({ concurrency: 100000, maxQueue: 100000 })
  });
  setExtractionLimiter(
    mode === 'spool' && CONCURRENCY > 0
      ? new ExtractionLimiter({ limits: () => ({ concurrency: CONCURRENCY, maxQueue: 100000 }) })
      : null
  );
  const app = await startUploadApp({
    store,
    policy: () => policy,
    scope: () => ({ type: 'chat', id: `probe-${mode}-${(counter += 1)}` }),
    mode,
    limiter: uncapped
  });
  try {
    const run = await measured(() =>
      Promise.all(Array.from({ length: UPLOADS }, () => streamUpload(app.port, UPLOAD_BYTES)))
    );
    const ok = run.value.every(
      response =>
        response.status === 201 &&
        response.body.sha256 === response.sha256 &&
        response.body.originalBytes === UPLOAD_BYTES
    );
    return {
      uploads: UPLOADS,
      bytesEach: UPLOAD_BYTES,
      ok,
      statuses: [...new Set(run.value.map(response => response.status))],
      peakArrayBuffers: run.peakArrayBuffers,
      peakRss: run.peakRss,
      ms: run.ms
    };
  } finally {
    await app.close();
    setExtractionLimiter(null);
  }
}

/** Members of an archive in the blob store: random bytes, so the archive is as large as they are. */
async function zipMembers() {
  const each = Math.floor(ZIP_BYTES / ZIP_MEMBERS);
  const block = crypto.randomBytes(MIB);
  const keys = [];
  for (let index = 0; index < ZIP_MEMBERS; index += 1) {
    const key = `probe-zip-${index}`;
    const pieces = (function* pieces() {
      for (let left = each; left > 0; left -= MIB) {
        const piece = Buffer.from(block.subarray(0, Math.min(MIB, left)));
        piece.writeUInt32BE(index * 1000 + left / MIB, 0);
        yield piece;
      }
    })();
    await provider.blobs.putStream('artifacts', key, Readable.from(pieces, { objectMode: false }), {
      bytes: each
    });
    keys.push(key);
  }
  return { keys, each };
}

try {
  for (const mode of MODES) {
    if (mode === 'spool' || mode === 'memory') result[mode] = await uploads(mode);
  }
  if (MODES.includes('zip-file') || MODES.includes('zip-buffer')) {
    const { keys, each } = await zipMembers();
    if (MODES.includes('zip-buffer')) {
      const run = await measured(async () => {
        // As `create_zip` did: every member read whole, then the archive in memory.
        const entries = [];
        for (const key of keys) {
          const blob = await provider.blobs.get('artifacts', key);
          entries.push({ path: `${key}.bin`, data: blob.data });
        }
        const archive = await zipToBuffer(entries);
        return archive.length;
      });
      result['zip-buffer'] = {
        contentBytes: each * keys.length,
        archiveBytes: run.value,
        peakArrayBuffers: run.peakArrayBuffers,
        peakRss: run.peakRss,
        ms: run.ms
      };
    }
    if (MODES.includes('zip-file')) {
      const file = path.join(scratch, 'archive.zip');
      const run = await measured(async () => {
        const entries = keys.map(key => ({
          path: `${key}.bin`,
          open: async () => (await provider.blobs.openRead('artifacts', key)).stream
        }));
        return zipToFile(entries, file, { maxContentBytes: each * keys.length });
      });
      result['zip-file'] = {
        contentBytes: run.value.contentBytes,
        archiveBytes: run.value.bytes,
        peakArrayBuffers: run.peakArrayBuffers,
        peakRss: run.peakRss,
        ms: run.ms
      };
    }
  }
} finally {
  await provider.shutdown?.();
  await fs.rm(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({ probe: 'upload-memory', ...result }));
// The extraction thread is unreferenced; nothing else keeps the process.
process.exit(0);
