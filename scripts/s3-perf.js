#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Performance check of the S3 blob backend: one 25 MiB blob (the default
 * upload limit) written and read through the storage provider as
 * `storage.blobs.provider: "s3"` composes it, with encryption on.
 *
 * It prints wall time, peak memory and the longest event-loop stall for
 * `put` and `get`, and the same for the filesystem blob store with encryption
 * on as the reference. Budgets should be relative to that reference: absolute
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
 * How to read the numbers. The blob facet is whole-buffer by contract: a
 * `put` holds the payload and its ciphertext, a `get` the ciphertext and the
 * plaintext. A peak of about two to three times the payload above the
 * baseline is the floor; more means an extra copy somewhere.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
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
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
// Quiet: the logger writes every blob call at warn/info to stdout otherwise.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

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
 */
async function measure(fn) {
  gc();
  await new Promise(resolve => setTimeout(resolve, 50));
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakBuffers = before.arrayBuffers;
  const sample = () => {
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakBuffers = Math.max(peakBuffers, now.arrayBuffers);
  };
  const timer = setInterval(sample, 5);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const startedAt = performance.now();
  const value = await fn();
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

/** Warm up once, then `ROUNDS` measured puts and gets of one payload. */
async function exercise(blobs, payload, expectedSha) {
  await blobs.put('chat-files', 'warmup', payload.subarray(0, MIB));
  await blobs.get('chat-files', 'warmup');
  const puts = [];
  const gets = [];
  for (let round = 0; round < ROUNDS; round++) {
    const key = `perf__${round}.bin`;
    puts.push(await measure(() => blobs.put('chat-files', key, payload)));
    const read = await measure(() => blobs.get('chat-files', key));
    const sha = crypto.createHash('sha256').update(read.value.data).digest('hex');
    if (sha !== expectedSha) throw new Error(`round ${round}: the blob came back changed`);
    read.value = null;
    gets.push(read);
    await blobs.delete('chat-files', key);
  }
  const summary = runs => ({
    medianMs: Math.round(median(runs.map(run => run.ms))),
    minMs: Math.round(Math.min(...runs.map(run => run.ms))),
    maxMs: Math.round(Math.max(...runs.map(run => run.ms))),
    mibPerSecond: Math.round(SIZE / MIB / (median(runs.map(run => run.ms)) / 1000)),
    peakRssMib: Math.max(...runs.map(run => run.peakRssMib)),
    peakArrayBuffersMib: Math.max(...runs.map(run => run.peakBuffersMib)),
    maxEventLoopStallMs: Math.max(...runs.map(run => run.maxLoopStallMs))
  });
  return { put: summary(puts), get: summary(gets) };
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
    `${label.padEnd(26)} ${String(run.medianMs).padStart(6)} ms  ${String(run.mibPerSecond).padStart(5)} MiB/s  ` +
    `peak RSS +${String(run.peakRssMib).padStart(6)} MiB  buffers +${String(run.peakArrayBuffersMib).padStart(6)} MiB  ` +
    `loop stall ${String(run.maxEventLoopStallMs).padStart(4)} ms`;
  console.log(
    [
      `S3 blob backend performance: ${report.payloadMib} MiB payload, median of ${ROUNDS}, Node ${report.node}, ${report.cpus} CPUs`,
      `S3 server: ${report.s3Server}${report.gcExposed ? '' : '  (run with --expose-gc for stable memory numbers)'}`,
      '',
      row('filesystem + encryption put', report.filesystemEncrypted.put),
      row('filesystem + encryption get', report.filesystemEncrypted.get),
      row('S3 + encryption         put', report.s3Encrypted.put),
      row('S3 + encryption         get', report.s3Encrypted.get),
      '',
      `S3 relative to filesystem: put x${report.s3OverFilesystem.put}, get x${report.s3OverFilesystem.get}`
    ].join('\n')
  );
}

main()
  .catch(error => {
    console.error(`The performance check failed: ${error?.stack || error}`);
    process.exitCode = 1;
  })
  .finally(() => fs.rm(scratch, { recursive: true, force: true }));
