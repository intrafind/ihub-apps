// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:copy-blobs`: copy the blobs the storage provider keeps on
 * local disk into the configured blob backend (S3).
 *
 * After `storage.blobs.provider` is set to `s3` the server reads blobs only
 * from the bucket. This command brings over what was stored before the
 * switch. It works in one direction, local disk to the configured backend.
 *
 * What it guarantees:
 * - **It never deletes or changes a source file.** There is no option for it.
 *   Remove `contents/data/blobs` yourself once the result has been checked.
 *   That is safe: nothing the server needs lives there any more. The key
 *   check object of the data directory, which an earlier build kept under
 *   `blobs/_ihub/`, is moved beside the state record by this command.
 * - **It never overwrites an object in the bucket.** A blob that is already
 *   there with the same content is counted as present; one with other content
 *   is counted as a conflict and left alone.
 * - **It is idempotent.** A second run copies only what is missing, so an
 *   interrupted run is simply run again.
 * - **It holds no blob in memory.** A blob is read, sent and read back as a
 *   stream, a segment at a time, so the largest blob needs no more memory
 *   than the smallest. A transfer that fails for a moment is sent again
 *   (three attempts per blob).
 * - **Every copy is verified**: the object is read back through the same path
 *   the server reads it (decrypted when encryption is on) and its SHA-256 is
 *   compared with that of the source content. A copy that does not verify is
 *   removed from the bucket and counted as failed.
 * - A local blob is read as it is, or decrypted first when it was stored
 *   encrypted (`storage.encryption.enabled` on local disk). What reaches the
 *   bucket is encrypted for the bucket, or plain when encryption is off.
 * - When it is the first to write into an empty bucket or prefix and
 *   encryption is on, it writes the key check object, as a server start would.
 *
 * **Run it while the server is stopped.** It is safe while the server runs
 * (nothing is deleted or overwritten on either side), but not complete: a
 * blob the server writes to local disk during the run can be missed, and a
 * server already on S3 may have stored a newer version of a blob, which then
 * shows up as a conflict.
 *
 * @module storage/commands/copyBlobs
 */
import crypto from 'node:crypto';
import { blobErrorHint } from '../blobOperatorGuide.js';
import { EncryptingBlobStore } from '../EncryptingBlobStore.js';
import {
  DEFAULT_BLOB_BACKEND,
  classifyBlobError,
  createBlobBackend,
  failedBlobProbe,
  resolveBlobStorageConfig,
  StorageError
} from '../index.js';
import { BLOB_NAMESPACES } from '../namespaces.js';
import { createLocalKeyCheckStore } from '../atRest/localKeyCheck.js';
import { ADOPT_BUCKET_ENV_VAR } from '../providers/s3/index.js';
import {
  formatByteSize,
  formatNumber,
  loadKeys,
  loadPlatformConfigFromDisk,
  openLocalBlobs,
  parseFlags,
  quietServerLog
} from './commandSupport.js';

const USAGE = `Usage: npm run storage:copy-blobs [-- --dry-run] [-- --namespace=<name>] [-- --json]

Copies the blobs on local disk into the blob storage configured in
contents/config/platform.json (storage.blobs.provider: "s3"). Stop the server
first. Nothing on local disk is deleted or changed, and nothing in the bucket
is overwritten. Exit code 0: every blob is in the bucket. Exit code 1: not.

  --dry-run           report what would be copied, write nothing
  --namespace=<name>  copy one namespace only (may be given as a list: a,b)
  --json              print the result as one JSON object
  --verbose           also print the server's own log lines
`;

/** Failures listed by name in the result; the rest are only counted. */
const MAX_LISTED_FAILURES = 20;

/** Times one blob is sent before it counts as failed. */
const COPY_ATTEMPTS = 3;

/**
 * The SHA-256 of a stream's content, read to its end.
 *
 * @param {import('node:stream').Readable} stream
 * @returns {Promise<string>} Hex digest.
 * @throws What the stream fails with (a blob that does not verify, a store
 *   that went away).
 */
async function sha256OfStream(stream) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Send one blob to the target as a stream and return the SHA-256 of what was
 * read from the source.
 *
 * A streamed upload is sent once by the backend (it cannot rewind a stream),
 * so the retries a buffered `put` gets are made here, by opening the source
 * again.
 *
 * @param {import('../BlobStore.js').BlobStore} source
 * @param {import('../BlobStore.js').BlobStore} target
 * @param {string} namespace
 * @param {string} key
 * @param {{bytes: number, stream: import('node:stream').Readable}} opened -
 *   The source blob, open; used for the first attempt.
 * @returns {Promise<string>} Hex digest of the source content.
 */
async function sendBlob(source, target, namespace, key, opened) {
  let blob = opened;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const ref = await target.putStream(namespace, key, blob.stream, { bytes: blob.bytes });
      return ref.sha256;
    } catch (error) {
      if (attempt >= COPY_ATTEMPTS || error?.code !== 'STORAGE_UNAVAILABLE') throw error;
      blob = await source.openRead(namespace, key);
      if (!blob) throw error;
    }
  }
}

/**
 * A reader for the blobs on local disk that returns their content whether
 * they were stored as they are or encrypted.
 *
 * @param {import('../BlobStore.js').BlobStore} local - The provider's blob facet.
 * @param {() => Object} keyProvider - Returns the key provider; only called
 *   for a blob that is encrypted.
 * @returns {EncryptingBlobStore} Used for reading only.
 */
export function openLocalBlobReader(local, keyProvider) {
  return new EncryptingBlobStore({
    inner: local,
    // The mode of a store whose blobs are being converted: an envelope is
    // opened, anything else is returned as it is. Nothing is written here.
    encryptWrites: true,
    plaintextReads: 'accept',
    maxBlobBytes: Number.MAX_SAFE_INTEGER,
    keyProvider
  });
}

/**
 * Counts of one namespace, or of the whole run.
 *
 * @typedef {Object} CopyCounts
 * @property {number} scanned - Blobs found on local disk.
 * @property {number} copied - Written and verified (in a dry run: would be written).
 * @property {number} alreadyPresent - In the bucket with the same content.
 * @property {number} conflicts - In the bucket with other content; left alone.
 * @property {number} failed - Could not be read, written or verified.
 * @property {number} bytes - Content bytes of the copied blobs.
 */

const emptyCounts = () => ({
  scanned: 0,
  copied: 0,
  alreadyPresent: 0,
  conflicts: 0,
  failed: 0,
  bytes: 0
});

/**
 * Copy the blobs of one store into another.
 *
 * @param {Object} options
 * @param {import('../BlobStore.js').BlobStore} options.source - Returns the
 *   content of a local blob (see {@link openLocalBlobReader}).
 * @param {import('../BlobStore.js').BlobStore} options.target - The blob
 *   facet of the target backend, as the server uses it.
 * @param {string[]} [options.namespaces] - Every `BLOB_NAMESPACES` value by default.
 * @param {boolean} [options.dryRun=false] - Compare only, write nothing.
 * @param {AbortSignal} [options.signal] - Stop before the next blob.
 * @param {(event: {namespace: string, key: string, action: 'copied'|'present'|'conflict'|'failed'}) => void} [options.onProgress]
 * @returns {Promise<CopyCounts & {aborted: boolean, namespaces: Record<string, CopyCounts>,
 *   failures: Array<{namespace: string, key: string, code: string, detail: string}>}>}
 *
 * @example
 * const result = await copyBlobs({ source, target: backend.blobs, dryRun: true });
 * console.log(result.namespaces['chat-files'].copied);
 */
export async function copyBlobs({
  source,
  target,
  namespaces = Object.values(BLOB_NAMESPACES),
  dryRun = false,
  signal,
  onProgress
}) {
  const totals = emptyCounts();
  const perNamespace = {};
  const failures = [];
  let aborted = false;
  // Keys come from the store that holds them; the reader decides per blob.
  const listing = source.inner || source;

  for (const namespace of namespaces) {
    const counts = emptyCounts();
    perNamespace[namespace] = counts;
    for await (const item of listing.scan(namespace)) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      counts.scanned += 1;
      let action;
      try {
        // Streams on both sides: a blob is never held whole, whatever its size.
        const blob = await source.openRead(namespace, item.key);
        if (!blob) {
          // Deleted since it was listed: not a blob of this run.
          counts.scanned -= 1;
          continue;
        }
        let existing;
        try {
          existing = await target.openRead(namespace, item.key);
        } catch (error) {
          blob.stream.destroy();
          throw error;
        }
        if (existing) {
          const [mine, theirs] = await Promise.allSettled([
            sha256OfStream(blob.stream),
            sha256OfStream(existing.stream)
          ]);
          if (mine.status === 'rejected') throw mine.reason;
          if (theirs.status === 'rejected') throw theirs.reason;
          action = mine.value === theirs.value ? 'present' : 'conflict';
        } else {
          if (dryRun) {
            blob.stream.destroy();
          } else {
            const hash = await sendBlob(source, target, namespace, item.key, blob);
            const stored = await target.openRead(namespace, item.key);
            let verified = false;
            try {
              verified = Boolean(stored) && (await sha256OfStream(stored.stream)) === hash;
            } catch {
              // Counted below as a copy that does not read back.
            }
            if (!verified) {
              // Do not leave a copy behind that is not the source's content.
              await target.delete(namespace, item.key).catch(() => {});
              const mismatch = new StorageError(
                'The copy did not read back with the content of the source and was removed',
                { code: 'IO_ERROR' }
              );
              mismatch.probeCode = 'S3_PROBE_MISMATCH';
              throw mismatch;
            }
          }
          counts.bytes += blob.bytes;
          action = 'copied';
        }
      } catch (error) {
        action = 'failed';
        if (failures.length < MAX_LISTED_FAILURES) {
          const classified = classifyBlobError(error);
          failures.push({
            namespace,
            key: item.key,
            code: error?.code === 'BLOB_TOO_LARGE' ? 'BLOB_TOO_LARGE' : classified.code,
            detail: classified.detail
          });
        }
      }
      if (action === 'copied') counts.copied += 1;
      else if (action === 'present') counts.alreadyPresent += 1;
      else if (action === 'conflict') counts.conflicts += 1;
      else counts.failed += 1;
      onProgress?.({ namespace, key: item.key, action });
    }
    for (const name of Object.keys(totals)) totals[name] += counts[name];
    if (aborted) break;
  }
  return { ...totals, aborted, namespaces: perNamespace, failures };
}

/**
 * The result of {@link runCopyBlobs}.
 *
 * @typedef {Object} CopyBlobsReport
 * @property {'ok'|'error'} status - `ok` when nothing failed, no conflict was
 *   found and the run was not interrupted.
 * @property {boolean} dryRun
 * @property {string} provider - Target blob backend.
 * @property {Object} [location] - Endpoint host, bucket, region, prefix.
 * @property {{enabled: boolean}} encryption
 * @property {{code: string, detail: string, step?: string, hint: string}|null} error -
 *   Why nothing was copied, when the target is not usable.
 * @property {CopyCounts} totals
 * @property {Record<string, CopyCounts>} namespaces
 * @property {Array<{namespace: string, key: string, code: string, detail: string}>} failures
 * @property {boolean} aborted
 */

/**
 * Run the copy for a configuration: check the target, write the key check
 * object if this is the first write into an empty prefix, copy, close.
 *
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration (raw file).
 * @param {Object} [options.env=process.env]
 * @param {boolean} [options.dryRun=false]
 * @param {string[]} [options.namespaces]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onProgress] - See {@link copyBlobs}.
 * @param {() => Promise<Object>} [options.keys] - Key module loader (tests).
 * @returns {Promise<CopyBlobsReport>} Never rejects for a target that is not usable.
 */
export async function runCopyBlobs({
  platformConfig = {},
  env = process.env,
  dryRun = false,
  namespaces,
  signal,
  onProgress,
  keys = loadKeys
} = {}) {
  const blobs = resolveBlobStorageConfig(platformConfig, env);
  const base = {
    dryRun,
    provider: blobs.provider,
    encryption: { enabled: blobs.encryption.enabled },
    totals: emptyCounts(),
    namespaces: {},
    failures: [],
    aborted: false
  };
  const refuse = (code, detail, hint = blobErrorHint(code)) => ({
    ...base,
    status: 'error',
    error: { code, detail, hint }
  });

  if (blobs.provider === DEFAULT_BLOB_BACKEND) {
    return refuse(
      'BLOB_COPY_NO_TARGET',
      'storage.blobs.provider is "default": the blobs are served from local disk and there is ' +
        'nothing to copy them to.',
      'Set storage.blobs.provider to "s3" and fill in storage.blobs.s3 first.'
    );
  }

  let local;
  try {
    local = openLocalBlobs(platformConfig, env);
  } catch (error) {
    const { code, detail } = classifyBlobError(error);
    return refuse(code, detail);
  }
  if (!local.blobs) {
    return refuse(
      'BLOB_STORAGE_ERROR',
      `The "${local.provider}" storage provider keeps no blobs that could be copied.`
    );
  }

  let backend;
  try {
    backend = createBlobBackend(blobs.provider, blobs.config, {
      platformConfig: blobs.platformConfig,
      // No lock manager: nothing else deletes in this process.
      locks: null,
      encryption: blobs.encryption,
      loadKeys: keys,
      env
    });
  } catch (error) {
    const { code, detail } = failedBlobProbe(blobs.provider, error).error;
    return refuse(code, detail);
  }

  try {
    // The check a server start runs. Not in a dry run: only a run that writes
    // may write the key check object into an empty prefix.
    const adopt = String(env?.[ADOPT_BUCKET_ENV_VAR] || '').toLowerCase() === 'true';
    const probe = await backend.probe({ createKeyCheck: !dryRun, adopt });
    const location = probe.location || backend.describe().location;
    if (probe.status !== 'ok') {
      return {
        ...base,
        ...(location ? { location } : {}),
        status: 'error',
        error: { ...probe.error, hint: blobErrorHint(probe.error.code) }
      };
    }

    // The key check object of the data directory used to be a blob. Move it
    // out of the blob tree before the operator is told that tree can go.
    if (!dryRun && local.baseDir) {
      await createLocalKeyCheckStore({ baseDir: local.baseDir, legacy: local.blobs })
        .read({ migrate: true })
        .catch(() => {});
    }

    let keyModule = null;
    try {
      keyModule = await keys();
      await keyModule.ensureMasterKey();
    } catch {
      // Only a local blob that is encrypted needs the key; it then fails by name.
    }
    const source = openLocalBlobReader(local.blobs, () => {
      if (!keyModule) throw new Error('no master key is available');
      return keyModule.getKeyProvider();
    });

    const result = await copyBlobs({
      source,
      target: backend.blobs,
      namespaces,
      dryRun,
      signal,
      onProgress
    });
    const { namespaces: perNamespace, failures, aborted, ...totals } = result;
    return {
      ...base,
      ...(location ? { location } : {}),
      status: totals.failed === 0 && totals.conflicts === 0 && !aborted ? 'ok' : 'error',
      error: null,
      totals,
      namespaces: perNamespace,
      failures,
      aborted
    };
  } finally {
    await backend.shutdown().catch(() => {});
  }
}

/**
 * The report as the lines the command prints.
 *
 * @param {CopyBlobsReport} report
 * @returns {string}
 */
export function formatCopyBlobs(report) {
  const lines = [
    `Blob copy: local disk to "${report.provider}"${
      report.dryRun ? ' (dry run: nothing is copied; one test object is written and removed)' : ''
    }`,
    'Run this while the server is stopped. If it is running, nothing is damaged, but a blob',
    'the server stores during the run can be missed: run the command again afterwards.',
    'Nothing on local disk is deleted or changed. Nothing in the bucket is overwritten.',
    ''
  ];
  if (report.location) {
    const { endpointHost, bucket, region, prefix } = report.location;
    lines.push(
      `  target      ${endpointHost}   bucket ${bucket}   prefix ${prefix || '(none)'}   region ${region}`
    );
  }
  lines.push(
    `  encryption  ${
      report.encryption.enabled
        ? 'on: every blob is encrypted before upload'
        : 'off: blobs are uploaded as they are'
    }`,
    ''
  );

  if (report.error) {
    lines.push(
      `Nothing was copied. ${report.error.code}: ${report.error.detail}`,
      report.error.hint,
      ''
    );
    lines.push('Result: failed.');
    return `${lines.join('\n')}\n`;
  }

  const copied = report.dryRun ? 'to copy' : 'copied';
  const header = ['namespace', 'found', copied, 'present', 'conflict', 'failed', 'size'];
  const rows = Object.entries(report.namespaces).map(([namespace, counts]) => [
    namespace,
    formatNumber(counts.scanned),
    formatNumber(counts.copied),
    formatNumber(counts.alreadyPresent),
    formatNumber(counts.conflicts),
    formatNumber(counts.failed),
    formatByteSize(counts.bytes)
  ]);
  rows.push([
    'total',
    formatNumber(report.totals.scanned),
    formatNumber(report.totals.copied),
    formatNumber(report.totals.alreadyPresent),
    formatNumber(report.totals.conflicts),
    formatNumber(report.totals.failed),
    formatByteSize(report.totals.bytes)
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map(row => row[column].length))
  );
  const render = row =>
    `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ')}`;
  lines.push(render(header), ...rows.map(render), '');

  for (const failure of report.failures) {
    lines.push(`  failed  ${failure.namespace}/${failure.key}  ${failure.code}: ${failure.detail}`);
  }
  if (report.totals.failed > report.failures.length) {
    lines.push(`  … and ${formatNumber(report.totals.failed - report.failures.length)} more.`);
  }
  if (report.failures.length > 0) lines.push('');
  if (report.totals.conflicts > 0) {
    lines.push(
      `${formatNumber(report.totals.conflicts)} blob(s) exist in the bucket with other content than on local disk.`,
      'They were left as they are in both places. The server serves the version in the bucket.',
      ''
    );
  }
  if (report.aborted) lines.push('The run was interrupted. Run the command again to continue.', '');

  if (report.dryRun) {
    lines.push(
      `Result: ${formatNumber(report.totals.copied)} blob(s) (${formatByteSize(report.totals.bytes)}) would be copied. ` +
        'Run again without --dry-run.'
    );
  } else if (report.status === 'ok') {
    lines.push(
      `Result: complete. ${formatNumber(report.totals.copied)} copied, ` +
        `${formatNumber(report.totals.alreadyPresent)} already present. The files on local disk ` +
        'are still there, in the form they had (plaintext stays plaintext). Check the result ' +
        '(npm run storage:check), then remove contents/data/blobs yourself. ' +
        'Remove nothing else in contents/data: .at-rest.json and .at-rest-keycheck there are ' +
        'needed to start with storage encryption on.'
    );
  } else {
    lines.push('Result: not complete. Correct the cause and run the command again.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The command.
 *
 * @param {string[]} [argv] - Arguments after the script name.
 * @param {Object} [io]
 * @param {(text: string) => void} [io.out] - Receives the output.
 * @param {Object} [io.env=process.env]
 * @param {AbortSignal} [io.signal] - Stops the run before the next blob.
 * @returns {Promise<number>} The exit code: 0 complete (in a dry run: the
 *   target is usable and nothing would fail), 1 not, 2 wrong usage.
 */
export async function main(
  argv = process.argv.slice(2),
  { out = text => process.stdout.write(text), env = process.env, signal } = {}
) {
  const { flags, unknown } = parseFlags(argv, ['dry-run', 'namespace', 'json', 'verbose', 'help']);
  const known = Object.values(BLOB_NAMESPACES);
  const namespaces =
    typeof flags.namespace === 'string'
      ? flags.namespace
          .split(',')
          .map(name => name.trim())
          .filter(Boolean)
      : undefined;
  const wrongNamespace =
    flags.namespace === true || (namespaces || []).some(name => !known.includes(name));
  if (flags.help || unknown.length > 0 || wrongNamespace) {
    const problem =
      unknown.length > 0
        ? `Unknown argument: ${unknown.join(' ')}\n\n`
        : wrongNamespace
          ? `--namespace takes one of: ${known.join(', ')}\n\n`
          : '';
    out(`${problem}${USAGE}`);
    return problem ? 2 : 0;
  }
  quietServerLog(flags.verbose === true);
  let report;
  try {
    report = await runCopyBlobs({
      platformConfig: await loadPlatformConfigFromDisk(),
      env,
      dryRun: flags['dry-run'] === true,
      namespaces,
      signal
    });
  } catch (error) {
    out(
      flags.json
        ? `${JSON.stringify({ status: 'error', error: { code: 'BLOB_STORAGE_ERROR', detail: error.message } })}\n`
        : `The blob copy could not run: ${error.message}\n`
    );
    return 1;
  }
  out(flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatCopyBlobs(report));
  return report.status === 'ok' ? 0 : 1;
}
