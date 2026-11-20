// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Measures how much memory a blob of a given size takes while it is written
 * and read through the encrypting blob store over an S3 server that runs in
 * **another process** (so that the server's own copy of the object is not
 * counted). Run by `storage-stream-s3.test.js` and by `scripts/s3-perf.js`:
 *
 *   node --expose-gc server/tests/support/streamMemoryProbe.js
 *
 * Environment: `PROBE_S3_ENDPOINT`, `PROBE_S3_BUCKET`, `PROBE_S3_ACCESS_KEY`,
 * `PROBE_S3_SECRET_KEY`, `PROBE_BYTES` (payload size), `PROBE_MODES` (comma
 * list of `stream`, `buffer`; both by default).
 *
 * What is measured: `process.memoryUsage().arrayBuffers`, which is where
 * every Buffer lives, sampled after a forced garbage collection (every 1 MiB
 * of payload, `PROBE_SAMPLE_BYTES`, and every 20 ms). The result is the
 * highest sample minus the sample before the operation started. It is an
 * upper bound of what is *held*: V8 frees the memory of collected buffers in
 * the background, so a sample still counts some of what was dropped since
 * the sample before (sampling every 8 MiB reads about 20 MiB higher).
 *
 * Prints one JSON object: per mode and operation `{ peakBytes, ms }`, and
 * whether what was read is what was written.
 */
import './scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { composeS3Provider, fixedKeys } from './blobTestSupport.js';

const keyModule = await import('../../crypto/KeyProvider.js');

const BYTES = Number(process.env.PROBE_BYTES || 100 * 1024 * 1024);
const MODES = (process.env.PROBE_MODES || 'stream,buffer').split(',');
const PIECE = 256 * 1024;
const NS = 'artifacts';

if (typeof globalThis.gc !== 'function') {
  console.error('Run this probe with node --expose-gc');
  process.exit(2);
}

const held = () => {
  globalThis.gc();
  return process.memoryUsage().arrayBuffers;
};

/** Runs `work`, sampling held memory through `sample()`, and reports the peak growth. */
async function measured(work) {
  // Let the memory of what came before be freed first: a baseline that still
  // counts it would hide what the operation takes.
  for (let round = 0; round < 5; round += 1) {
    globalThis.gc();
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const before = held();
  let peak = before;
  const sample = () => {
    peak = Math.max(peak, held());
  };
  const startedAt = performance.now();
  // Also on a timer: a buffered call holds its copies inside one await.
  const timer = setInterval(sample, 20);
  let value;
  try {
    value = await work(sample);
  } finally {
    clearInterval(timer);
  }
  sample();
  return {
    value,
    peakBytes: peak - before,
    ms: Math.round(performance.now() - startedAt)
  };
}

/** One block of random bytes, sent again and again with a counter in front. */
const block = crypto.randomBytes(PIECE);

/** The payload, piece by piece; never held as a whole. */
function* payloadPieces() {
  let index = 0;
  for (let left = BYTES; left > 0; left -= PIECE, index += 1) {
    const piece = Buffer.from(block.subarray(0, Math.min(PIECE, left)));
    if (piece.length >= 4) piece.writeUInt32BE(index, 0);
    yield piece;
  }
}

function payloadHash() {
  const hash = crypto.createHash('sha256');
  for (const piece of payloadPieces()) hash.update(piece);
  return hash.digest('hex');
}

const composed = await composeS3Provider({
  s3: {
    endpoint: process.env.PROBE_S3_ENDPOINT,
    accessKeyId: process.env.PROBE_S3_ACCESS_KEY,
    secretAccessKey: process.env.PROBE_S3_SECRET_KEY
  },
  keys: fixedKeys(keyModule),
  config: {
    bucket: process.env.PROBE_S3_BUCKET,
    prefix: `probe-${crypto.randomBytes(4).toString('hex')}`,
    maxAttempts: 1
  }
});
await composed.provider.initialize();
const blobs = composed.provider.blobs;
const expected = payloadHash();
const result = {
  bytes: BYTES,
  sampleEveryBytes: Number(process.env.PROBE_SAMPLE_BYTES || 1024 * 1024)
};

try {
  if (MODES.includes('stream')) {
    const write = await measured(async sample => {
      let sent = 0;
      let nextSample = result.sampleEveryBytes;
      const source = Readable.from(
        (function* sampled() {
          for (const piece of payloadPieces()) {
            sent += piece.length;
            if (sent >= nextSample) {
              nextSample += result.sampleEveryBytes;
              sample();
            }
            yield piece;
          }
        })(),
        { objectMode: false }
      );
      return blobs.putStream(NS, 'streamed', source, { bytes: BYTES });
    });
    const read = await measured(async sample => {
      const opened = await blobs.openRead(NS, 'streamed');
      const hash = crypto.createHash('sha256');
      let received = 0;
      let nextSample = result.sampleEveryBytes;
      for await (const chunk of opened.stream) {
        hash.update(chunk);
        received += chunk.length;
        if (received >= nextSample) {
          nextSample += result.sampleEveryBytes;
          sample();
        }
      }
      return { announced: opened.bytes, received, sha256: hash.digest('hex') };
    });
    result.stream = {
      write: { peakBytes: write.peakBytes, ms: write.ms },
      read: { peakBytes: read.peakBytes, ms: read.ms },
      intact:
        write.value.sha256 === expected &&
        read.value.sha256 === expected &&
        read.value.received === BYTES &&
        read.value.announced === BYTES
    };
  }
  if (MODES.includes('buffer')) {
    const write = await measured(async sample => {
      const payload = Buffer.concat([...payloadPieces()]);
      sample();
      return blobs.put(NS, 'buffered', payload);
    });
    const read = await measured(async sample => {
      const blob = await blobs.get(NS, 'buffered');
      sample();
      return crypto.createHash('sha256').update(blob.data).digest('hex');
    });
    result.buffer = {
      write: { peakBytes: write.peakBytes, ms: write.ms },
      read: { peakBytes: read.peakBytes, ms: read.ms },
      intact: write.value.sha256 === expected && read.value === expected
    };
  }
} finally {
  await blobs.deletePrefix(NS, 'streamed').catch(() => {});
  await blobs.deletePrefix(NS, 'buffered').catch(() => {});
  await composed.provider.shutdown();
  await fs.rm(composed.baseDir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
