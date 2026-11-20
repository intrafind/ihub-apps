#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Performance check of the S3 blob backend: one 25 MiB blob (the default
 * upload limit) written and read through the storage provider as
 * `storage.blobs.provider: "s3"` composes it, with encryption on.
 *
 * It prints wall time, peak memory and the longest event-loop stall for the
 * buffered calls (`put`, `get`) and the streamed ones (`putStream`,
 * `openRead`), and the same for the filesystem blob store with encryption on
 * as the reference. Budgets should be relative to that reference: absolute
 * seconds differ per machine.
 *
 * Not a test and not part of any default test run. Run it by hand:
 *
 *   npm run test:s3:perf            # = node --expose-gc scripts/s3-perf.js
 *   node --expose-gc scripts/s3-perf.js --mib 25 --rounds 5 --json
 *
 * S3 server: the in-repo one, started as a separate process so that its
 * memory does not count. With `IHUB_TEST_S3_ENDPOINT` set (see
 * `server/tests/support/s3TestBackend.js`) it measures against that server.
 *
 * How to read the numbers. `put` and `get` are whole-buffer by contract: a
 * `put` holds the payload and its ciphertext, a `get` the ciphertext and the
 * plaintext. A peak of about two to three times the payload above the
 * baseline is their floor; more means an extra copy somewhere. `putStream`
 * and `openRead` work a 1 MiB segment at a time: what they hold ("held", a
 * round with the collector forced) stays at a few MiB whatever `--mib` is,
 * and that column growing with the payload is a regression.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { findFreePort } from '../server/tests/support/serverProcess.js';
import { externalS3Mode, openS3Target } from '../server/tests/support/s3TestBackend.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const MIB = 1024 * 1024;
const SIZE = option('mib', 25) * MIB;
const ROUNDS = option('rounds', 3);
const asJson = args.includes('--json');

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-perf-'));
// Quiet: the logger writes every blob call at warn/info to stdout otherwise.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// Before any server module: points CONTENTS_DIR at a scratch directory.
await import('../server/tests/support/scratchContents.js');

const keyModule = await import('../server/crypto/KeyProvider.js');
const { composeS3Provider, fixedKeys } = await import('../server/tests/support/blobTestSupport.js');
const { FilesystemStorageProvider } =
  await import('../server/storage/providers/filesystem/index.js');
const { EncryptingBlobStore } = await import('../server/storage/EncryptingBlobStore.js');

const gc = () => globalThis.gc?.();
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const toMib = bytes => Math.round((bytes / MIB) * 10) / 10;

/**
 * Run `fn` and report its wall time, the peak of RSS and of memory held in
 * ArrayBuffers above the level before it, and the longest event-loop stall.
 *
 * With `forceGc` the garbage collector runs before every memory sample, so
 * the ArrayBuffer peak is what the call *holds* and not also what it has
 * dropped and the collector has not freed yet. That costs time: such a run is
 * for the memory number only.
 */
async function measure(fn, { forceGc = false } = {}) {
  for (let round = 0; round < (forceGc ? 5 : 1); round++) {
    gc();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakBuffers = before.arrayBuffers;
  const sample = () => {
    if (forceGc) gc();
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakBuffers = Math.max(peakBuffers, now.arrayBuffers);
  };
  const timer = setInterval(sample, forceGc ? 10 : 5);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const startedAt = performance.now();
  const value = await fn(sample);
  const ms = performance.now() - startedAt;
  sample();
  // Let the delayed timer of the monitor fire: a stall that lasted until `fn`
  // settled is only recorded on the next turn of the loop.
  await new Promise(resolve => setTimeout(resolve, 20));
  loop.disable();
  clearInterval(timer);
  return {
    value,
    ms,
    peakRssMib: toMib(peakRss - before.rss),
    peakBuffersMib: toMib(peakBuffers - before.arrayBuffers),
    maxLoopStallMs: Math.round(loop.max / 1e6)
  };
}

/** The payload as a stream of 256 KiB views: nothing is copied to make it. */
function payloadStream(payload) {
  const pieces = [];
  for (let offset = 0; offset < payload.length; offset += 256 * 1024) {
    pieces.push(payload.subarray(offset, offset + 256 * 1024));
  }
  return Readable.from(pieces, { objectMode: false });
}

/**
 * Read a blob stream to its end without keeping it.
 *
 * @param {import('node:stream').Readable} stream
 * @param {Object} [options]
 * @param {boolean} [options.hash=false] - Also compute the SHA-256.
 * @param {() => void} [options.sample] - Called about once per MiB.
 * @returns {Promise<{bytes: number, sha256: string|null}>}
 */
async function consume(stream, { hash = false, sample } = {}) {
  const digest = hash ? crypto.createHash('sha256') : null;
  let bytes = 0;
  let nextSample = MIB;
  for await (const chunk of stream) {
    digest?.update(chunk);
    bytes += chunk.length;
    if (sample && bytes >= nextSample) {
      nextSample += MIB;
      sample();
    }
  }
  return { bytes, sha256: digest ? digest.digest('hex') : null };
}

/**
 * Warm up once, then `ROUNDS` measured rounds of one payload, written and
 * read whole (`put`, `get`) and as a stream (`putStream`, `openRead`), and
 * one more round per call with the collector forced, for the memory held.
 */
async function exercise(blobs, payload, expectedSha) {
  await blobs.put('chat-files', 'warmup', payload.subarray(0, MIB));
  await blobs.get('chat-files', 'warmup');
  const ops = {
    put: key => () => blobs.put('chat-files', key, payload),
    get: key => () => blobs.get('chat-files', key),
    putStream: key => () =>
      blobs.putStream('chat-files', key, payloadStream(payload), { bytes: payload.length }),
    // Timed without hashing, as `get` is; the content is checked in the memory round.
    openRead: key => async () => consume((await blobs.openRead('chat-files', key)).stream)
  };
  const runs = { put: [], get: [], putStream: [], openRead: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const key = `perf__${round}.bin`;
    const streamedKey = `perf__${round}.streamed.bin`;
    runs.put.push(await measure(ops.put(key)));
    const read = await measure(ops.get(key));
    const sha = crypto.createHash('sha256').update(read.value.data).digest('hex');
    if (sha !== expectedSha) throw new Error(`round ${round}: the blob came back changed`);
    read.value = null;
    runs.get.push(read);
    const written = await measure(ops.putStream(streamedKey));
    if (written.value.sha256 !== expectedSha) {
      throw new Error(`round ${round}: putStream reported another hash`);
    }
    runs.putStream.push(written);
    const streamed = await measure(ops.openRead(streamedKey));
    if (streamed.value.bytes !== payload.length) {
      throw new Error(`round ${round}: the streamed blob has another length`);
    }
    runs.openRead.push(streamed);
    await blobs.delete('chat-files', key);
    await blobs.delete('chat-files', streamedKey);
  }

  // The memory each call holds: one more round with the collector forced.
  const held = {};
  {
    const key = 'perf__held.bin';
    held.put = (await measure(ops.put(key), { forceGc: true })).peakBuffersMib;
    const read = await measure(ops.get(key), { forceGc: true });
    read.value = null;
    held.get = read.peakBuffersMib;
    held.putStream = (await measure(ops.putStream(key), { forceGc: true })).peakBuffersMib;
    const streamed = await measure(
      async sample =>
        consume((await blobs.openRead('chat-files', key)).stream, { hash: true, sample }),
      { forceGc: true }
    );
    if (streamed.value.sha256 !== expectedSha) {
      throw new Error('the streamed blob came back changed');
    }
    held.openRead = streamed.peakBuffersMib;
    await blobs.delete('chat-files', key);
  }

  const summary = name => ({
    medianMs: Math.round(median(runs[name].map(run => run.ms))),
    minMs: Math.round(Math.min(...runs[name].map(run => run.ms))),
    maxMs: Math.round(Math.max(...runs[name].map(run => run.ms))),
    mibPerSecond: Math.round(SIZE / MIB / (median(runs[name].map(run => run.ms)) / 1000)),
    peakRssMib: Math.max(...runs[name].map(run => run.peakRssMib)),
    peakArrayBuffersMib: Math.max(...runs[name].map(run => run.peakBuffersMib)),
    heldArrayBuffersMib: held[name],
    maxEventLoopStallMs: Math.max(...runs[name].map(run => run.maxLoopStallMs))
  });
  return {
    put: summary('put'),
    putStream: summary('putStream'),
    get: summary('get'),
    openRead: summary('openRead')
  };
}

/** The in-repo S3 server in a process of its own. */
async function startFakeProcess() {
  const port = await findFreePort();
  const script = fileURLToPath(new URL('../server/tests/support/fakeS3Server.js', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      IHUB_S3_DEV_PORT: String(port),
      IHUB_S3_DEV_BUCKET: 'ihub-test',
      IHUB_S3_DEV_DIR: path.join(scratch, 's3-data')
    },
    stdio: 'ignore'
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(500) });
      return { endpoint, stop: () => void child.kill('SIGTERM') };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  child.kill('SIGKILL');
  throw new Error('the in-repo S3 server did not start');
}

async function main() {
  const payload = crypto.randomBytes(SIZE);
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
  const keys = fixedKeys(keyModule);
  const report = {
    payloadMib: SIZE / MIB,
    rounds: ROUNDS,
    node: process.version,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    gcExposed: typeof globalThis.gc === 'function'
  };

  // Reference: the filesystem blob store with the same encryption in front.
  {
    const baseDir = await fs.mkdtemp(path.join(scratch, 'fs-'));
    const provider = new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 });
    await provider.initialize();
    const encrypted = new EncryptingBlobStore({
      inner: provider.blobs,
      encryptWrites: true,
      plaintextReads: 'reject',
      keyProvider: () => keys.provider
    });
    report.filesystemEncrypted = await exercise(encrypted, payload, expectedSha);
    await provider.shutdown();
  }

  // The S3 blob backend.
  {
    const external = externalS3Mode();
    if (external.mode === 'fail') throw new Error(external.reason);
    let fake = null;
    let config;
    let close = async () => {};
    if (external.mode === 'run') {
      const target = await openS3Target('external');
      config = target.config();
      close = () => target.close();
      report.s3Server = `external (${target.endpoint})`;
    } else {
      fake = await startFakeProcess();
      config = {
        endpoint: fake.endpoint,
        bucket: 'ihub-test',
        prefix: `perf-${crypto.randomBytes(4).toString('hex')}`,
        accessKeyId: 'ihub-dev-not-a-secret',
        secretAccessKey: 'ihub-dev-not-a-secret'
      };
      report.s3Server = 'in-repo fake, separate process, loopback';
    }
    const { provider, baseDir } = await composeS3Provider({ s3: {}, keys, config });
    try {
      await provider.initialize();
      report.s3Encrypted = await exercise(provider.blobs, payload, expectedSha);
    } finally {
      await provider.shutdown().catch(() => {});
      await fs.rm(baseDir, { recursive: true, force: true });
      await close();
      fake?.stop();
    }
  }

  report.s3OverFilesystem = {
    put:
      Math.round(
        (report.s3Encrypted.put.medianMs / report.filesystemEncrypted.put.medianMs) * 100
      ) / 100,
    get:
      Math.round(
        (report.s3Encrypted.get.medianMs / report.filesystemEncrypted.get.medianMs) * 100
      ) / 100
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const row = (label, run) =>
    `${label.padEnd(33)} ${String(run.medianMs).padStart(6)} ms  ${String(run.mibPerSecond).padStart(5)} MiB/s  ` +
    `peak RSS +${String(run.peakRssMib).padStart(6)} MiB  buffers +${String(run.peakArrayBuffersMib).padStart(6)} MiB  ` +
    `held +${String(run.heldArrayBuffersMib).padStart(6)} MiB  ` +
    `loop stall ${String(run.maxEventLoopStallMs).padStart(4)} ms`;
  const rows = (label, result) => [
    row(`${label} put`, result.put),
    row(`${label} putStream`, result.putStream),
    row(`${label} get`, result.get),
    row(`${label} openRead`, result.openRead)
  ];
  console.log(
    [
      `S3 blob backend performance: ${report.payloadMib} MiB payload, median of ${ROUNDS}, Node ${report.node}, ${report.cpus} CPUs`,
      `S3 server: ${report.s3Server}${report.gcExposed ? '' : '  (run with --expose-gc for stable memory numbers)'}`,
      '',
      ...rows('filesystem + encryption', report.filesystemEncrypted),
      ...rows('S3 + encryption        ', report.s3Encrypted),
      '',
      `S3 relative to filesystem: put x${report.s3OverFilesystem.put}, get x${report.s3OverFilesystem.get}`,
      '',
      '"buffers" is the ArrayBuffer peak as sampled, garbage included; "held" is the same after a',
      'forced collection, from one extra round: what the call keeps alive at once.'
    ].join('\n')
  );
}

main()
  .catch(error => {
    console.error(`The performance check failed: ${error?.stack || error}`);
    process.exitCode = 1;
  })
  .finally(() => fs.rm(scratch, { recursive: true, force: true }));
