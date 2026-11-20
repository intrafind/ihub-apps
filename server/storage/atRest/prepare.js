// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The start-up step of encryption at rest: bring the data directory in line
 * with the switch (`storage.encryption.enabled`) before any worker exists.
 *
 * It runs once per start, in the cluster primary before the fork or in the
 * single process, after the configuration migrations and with the master key
 * loaded. It is also what `npm run storage:encrypt` runs with the server
 * stopped.
 *
 * | Switch | State record | What happens |
 * | --- | --- | --- |
 * | off | none or `off` | nothing |
 * | off | `complete` or `converting` | the record is set to `off`; nothing is converted |
 * | on | `complete` | the master key is checked against the key check object |
 * | on | anything else | preconditions, record `converting`, conversion, verification, record `complete` |
 *
 * The conversion is crash-safe: every object is replaced in one rename and is
 * recognised by its own format, and each facet (blobs, documents, logs, files) is
 * added to the record when it has been verified. A start after a crash finds
 * `converting` and continues.
 *
 * The workers started afterwards find `complete` and read strictly. A worker
 * that finds anything else refuses to start (`FilesystemStorageProvider`).
 *
 * **One process at a time.** Everything that writes runs under a lease of the
 * provider's lock manager ({@link CONVERSION_LEASE}), renewed while it runs.
 * A server start that finds the lease held waits for it and then looks at the
 * state record again; the command refuses and says so. The lease does not see
 * a server that is already serving: the command is for a stopped installation.
 *
 * **A missing state record does not bring plaintext back.** When the record
 * is gone but the key check object or sealed objects are there, the data
 * directory is treated as converted: it is verified, and the record is written
 * again when no plaintext object is found. Plaintext found then is refused
 * unless the operator confirms it for one run ({@link ACCEPT_PLAINTEXT_ENV_VAR}).
 *
 * **Blobs in a bucket** (`storage.blobs.provider: "s3"`) are converted by the
 * command only (`convertRemoteBlobs`), never by a start: a start that finds
 * plaintext blobs in the bucket refuses and names the command. The record
 * lists the bucket as the facet `remoteBlobs` once it holds only encrypted
 * blobs.
 *
 * @module storage/atRest/prepare
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compareCodeUnits } from '../../../shared/toolApproval.js';
import logger from '../../utils/logger.js';
import { EncryptingBlobStore } from '../EncryptingBlobStore.js';
import { encryptExistingBlobs } from '../encryptExistingBlobs.js';
import { LockTimeoutError, StorageError } from '../errors.js';
import {
  createBlobBackend,
  createProvider,
  resolveBlobStorageConfig,
  resolveStorageConfig
} from '../index.js';
import { checkMasterKey } from '../localBlobBackend.js';
import { BLOB_NAMESPACES } from '../namespaces.js';
import { convertStorage, isEmptyStorage, plaintextRemaining } from './convert.js';
import { createLocalKeyCheckStore } from './localKeyCheck.js';
import { createSealedFilesTarget } from './sealedFiles.js';
import {
  CURRENT_FACETS,
  REMOTE_BLOBS_FACET,
  isConversionComplete,
  isFacetComplete,
  isRemoteBlobFacetComplete,
  readAtRestState,
  recordsSealedData,
  writeAtRestState
} from './state.js';

const COMPONENT = 'StorageEncryption';

/** How often the conversion reports its progress. */
const PROGRESS_INTERVAL_MS = 10_000;

/** Share of the plaintext document and log bytes the conversion needs free (base64). */
const GROWTH_SHARE = 0.35;

/** Environment switch that adopts stored data without a key check object, for one start. */
const ADOPT_ENV_VAR = 'IHUB_S3_ADOPT_BUCKET';

/**
 * Environment switch that lets one run seal plaintext objects although the
 * state record is missing while sealed data exists. Without it such plaintext
 * is refused: it may have been put there by whoever removed the record.
 */
export const ACCEPT_PLAINTEXT_ENV_VAR = 'IHUB_ENCRYPTION_ACCEPT_PLAINTEXT';

/** Name of the lease that makes the conversion exclusive across processes. */
export const CONVERSION_LEASE = 'storage-at-rest-conversion';

/** A holder that stops renewing for this long is presumed dead. */
const LEASE_TTL_MS = 60_000;

/** One attempt of a start that waits for the lease; it reports after each. */
const LEASE_WAIT_SLICE_MS = 10_000;

/** Bytes an object grows by when it is sealed as a file or blob, generously. */
const ENVELOPE_OVERHEAD_BYTES = 1024;

/**
 * What under `contents/` can hold user content and is not encrypted, relative
 * to the contents directory or, with `data: true`, to the data directory:
 *
 * - `.backups`: what a backup import replaced, in the form it had then;
 * - `feedback.jsonl`: read with `jq` and `grep` and rotated by hand
 *   (docs/feedback-feature.md);
 * - `ifinder-downloads`: documents saved for use outside iHub;
 * - `tmp/project-uploads`: uploads waiting for extraction, removed with the
 *   request and swept after an hour;
 * - `debug/llm-*`: request dumps of the LLM debug switch, meant to be read.
 *
 * The stores of `./sealedFiles.js` are not in this list: they are converted.
 */
const PLAINTEXT_STORES = Object.freeze([
  { path: '.backups', data: false },
  { path: 'feedback.jsonl', data: true },
  { path: 'ifinder-downloads', data: true },
  { path: path.join('tmp', 'project-uploads'), data: true },
  { path: path.join('debug', 'llm-request'), data: true },
  { path: path.join('debug', 'llm-failures'), data: true }
]);

const loadKeyModule = () => import('../../crypto/KeyProvider.js');

/**
 * The conversion cannot start or did not finish. `code` is one of
 * `ENCRYPTION_PRECONDITION` (key, free space, key check),
 * `ENCRYPTION_INCOMPLETE` (plaintext is left after the conversion, or what
 * was sealed does not open), `CONVERSION_IN_PROGRESS` (another process holds
 * the lease), `ENCRYPTION_STATE_MISSING` (the state record is gone and
 * plaintext was found beside sealed data), `REMOTE_BLOBS_PLAINTEXT` (the
 * bucket holds blobs that are not encrypted) and `REMOTE_BLOBS_FOREIGN_KEY`
 * (it holds blobs encrypted with a master key that is not here).
 */
export class StorageEncryptionError extends StorageError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.code='ENCRYPTION_PRECONDITION']
   * @param {unknown} [options.cause]
   */
  constructor(message, { code = 'ENCRYPTION_PRECONDITION', cause } = {}) {
    super(message, { code, cause });
    this.name = 'StorageEncryptionError';
  }
}

/**
 * A rough duration of the conversion from what a dry run counted.
 *
 * @param {import('./convert.js').ConversionReport} report - Of a dry run.
 * @returns {number} Seconds on a local SSD; a network volume takes 10 to 20 times as long.
 */
export function estimateSeconds(report) {
  const objects =
    report.documents.plaintext +
    report.spillBlobs.plaintext +
    report.blobs.plaintext +
    report.files.plaintext;
  const bytes =
    report.documents.plaintextBytes +
    report.streams.plaintextBytes +
    report.spillBlobs.plaintextBytes +
    report.files.plaintextBytes;
  return Math.ceil(objects * 0.0005 + report.streams.plaintext * 0.002 + bytes / 40e6);
}

/** The counts of a report that go into a log line or the state record. */
function summarize(report) {
  return {
    documents: report.documents.plaintext,
    streams: report.streams.plaintext,
    records: report.records,
    spillBlobs: report.spillBlobs.plaintext,
    blobs: report.blobs.plaintext,
    files: report.files.plaintext
  };
}

/**
 * The plaintext stores of section "what is not covered" that hold something.
 *
 * @param {string} baseDir - Data directory.
 * @returns {Promise<string[]>} Paths relative to the contents directory.
 */
async function plaintextStoresPresent(baseDir) {
  const contentsDir = path.dirname(baseDir);
  const present = [];
  for (const store of PLAINTEXT_STORES) {
    const absolute = path.join(store.data ? baseDir : contentsDir, store.path);
    try {
      const stat = await fs.stat(absolute);
      const holds = stat.isDirectory() ? (await fs.readdir(absolute)).length > 0 : stat.size > 0;
      if (holds) present.push(path.relative(contentsDir, absolute));
    } catch {
      // Not there.
    }
  }
  return present;
}

/**
 * Refuse when the volume cannot hold the conversion: the largest object once
 * more (each one is written beside its original before the rename), the
 * growth of documents and log lines (base64), and the envelope of every blob
 * and file.
 *
 * @param {string} baseDir
 * @param {import('./convert.js').ConversionReport} report - Of a dry run.
 * @returns {Promise<{neededBytes: number, freeBytes: number|null}>}
 * @throws {StorageEncryptionError}
 */
async function checkFreeSpace(baseDir, report) {
  const largest = Math.max(
    report.documents.largestBytes,
    report.streams.largestBytes,
    report.spillBlobs.largestBytes,
    report.blobs.largestBytes,
    report.files.largestBytes
  );
  const growing = report.documents.plaintextBytes + report.streams.plaintextBytes;
  const enveloped = report.blobs.plaintext + report.files.plaintext + report.spillBlobs.plaintext;
  const envelopedBytes =
    report.blobs.plaintextBytes + report.files.plaintextBytes + report.spillBlobs.plaintextBytes;
  const neededBytes = Math.ceil(
    largest * 1.35 +
      growing * GROWTH_SHARE +
      enveloped * ENVELOPE_OVERHEAD_BYTES +
      // 16 bytes of tag per 1 MiB segment.
      (envelopedBytes / (1024 * 1024)) * 16
  );
  let freeBytes = null;
  try {
    const stats = await fs.statfs(baseDir);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // A filesystem that does not answer: the conversion finds out.
    return { neededBytes, freeBytes };
  }
  if (freeBytes < neededBytes) {
    throw new StorageEncryptionError(
      `Not enough free space in ${baseDir} to encrypt the stored data: about ` +
        `${Math.ceil(neededBytes / 1e6)} MB are needed, ${Math.floor(freeBytes / 1e6)} MB are free.`
    );
  }
  return { neededBytes, freeBytes };
}

/** Sealed objects a dry run found, of every kind. */
function sealedObjects(report) {
  return (
    report.documents.sealed +
    report.blobs.sealed +
    report.files.sealed +
    report.spillBlobs.sealed +
    report.sealedRecords
  );
}

/** Plaintext objects a dry run found, of every kind. */
function plaintextObjects(report) {
  return Object.values(plaintextRemaining(report)).reduce((sum, count) => sum + count, 0);
}

/**
 * Run `work` while holding the conversion lease.
 *
 * @param {Object} locks - The provider's lock manager.
 * @param {Object} options
 * @param {number} options.waitMs - How long to wait for a lease another
 *   process holds: `Infinity` for a server start, 0 for the command.
 * @param {AbortSignal} [options.signal] - Ends the wait.
 * @param {(level: string, line: string, meta?: Object) => void} options.say
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 * @throws {StorageEncryptionError} Code `CONVERSION_IN_PROGRESS`.
 * @template T
 */
async function withConversionLease(locks, { waitMs, signal, say }, work) {
  const startedAt = Date.now();
  let holding = false;
  for (;;) {
    const left = waitMs - (Date.now() - startedAt);
    try {
      return await locks.withLock(
        CONVERSION_LEASE,
        () => {
          holding = true;
          return work();
        },
        { ttlMs: LEASE_TTL_MS, waitMs: Math.max(1, Math.min(LEASE_WAIT_SLICE_MS, left)) }
      );
    } catch (error) {
      if (holding || !(error instanceof LockTimeoutError)) throw error;
      if (Date.now() - startedAt >= waitMs || signal?.aborted) {
        throw new StorageEncryptionError(
          'Another process is encrypting or checking the stored data of this data directory ' +
            '(a server that is starting, or another "npm run storage:encrypt"). Wait until it ' +
            'has finished, make sure every server that uses this data directory is stopped, ' +
            'and run the command again.',
          { code: 'CONVERSION_IN_PROGRESS', cause: error }
        );
      }
      say(
        'info',
        'Another process is encrypting the stored data of this data directory; waiting for it to finish',
        { waitedSeconds: Math.round((Date.now() - startedAt) / 1000) }
      );
    }
  }
}

/**
 * Bring the data directory in line with the encryption switch.
 *
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration (raw file).
 * @param {Object} [options.env=process.env]
 * @param {boolean} [options.dryRun=false] - Report what a conversion would do
 *   and whether its preconditions hold. Writes nothing: no record, no key
 *   check object, no key file, and it takes no lease.
 * @param {boolean} [options.force=false] - Convert although the switch is off
 *   (`npm run storage:encrypt` ahead of switching it on).
 * @param {boolean} [options.convertRemoteBlobs=false] - Also encrypt plaintext
 *   blobs in the bucket of a remote blob backend. The command sets it; a
 *   server start never does and refuses instead.
 * @param {number} [options.leaseWaitMs=Infinity] - How long to wait when
 *   another process holds the conversion lease. A server start waits; the
 *   command passes 0 and fails with `CONVERSION_IN_PROGRESS`.
 * @param {AbortSignal} [options.signal] - Stop before the next object; the
 *   record stays `converting` and the next run continues.
 * @param {() => Promise<Object>} [options.loadKeys] - Resolves with the key
 *   module (`crypto/KeyProvider.js`); for tests.
 * @param {(line: string, meta: Object) => void} [options.onLog] - Receives
 *   every progress line in addition to the log (the command prints them).
 * @param {(event: {facet: string, name: string}) => void} [options.onObject] -
 *   Called once per object the conversion has dealt with.
 * @returns {Promise<{action: 'none'|'unsupported'|'disabled'|'verified'|'converted'|'dry-run'|'aborted',
 *   enabled: boolean, baseDir: string|null, state: Object|null,
 *   report: import('./convert.js').ConversionReport|null, estimateSeconds?: number,
 *   neededBytes?: number, freeBytes?: number|null, plaintextStores?: string[],
 *   masterKey?: 'present'|'absent', remoteBlobs?: Object|null,
 *   localPlaintextBlobs?: number, stateRecordMissing?: boolean}>}
 *   `masterKey: 'absent'` only in a dry run of an installation that has no
 *   key yet. `remoteBlobs` describes the bucket of a remote blob backend
 *   (`status`, counts). `localPlaintextBlobs` counts blob files left in the
 *   data directory from before the blobs moved to a bucket: they are not used
 *   and not encrypted.
 * @throws {StorageEncryptionError} When a precondition does not hold or
 *   plaintext is left. The caller refuses to start.
 * @throws {import('../errors.js').KeyUnavailableError} When the master key is
 *   missing or is not the one the data was encrypted with.
 *
 * @example
 * const result = await prepareStorageEncryption({ platformConfig, dryRun: true });
 * // { action: 'dry-run', report: { documents: { plaintext: 120, … }, … }, estimateSeconds: 2 }
 */
export async function prepareStorageEncryption({
  platformConfig = {},
  env = process.env,
  dryRun = false,
  force = false,
  convertRemoteBlobs = false,
  leaseWaitMs = Infinity,
  signal,
  loadKeys = loadKeyModule,
  onLog,
  onObject
} = {}) {
  const say = (level, line, meta = {}) => {
    logger[level](line, { component: COMPONENT, ...meta });
    onLog?.(line, meta);
  };
  const { provider: name, config, encryption } = resolveStorageConfig(platformConfig, env);
  const enabled = encryption.enabled;
  const base = createProvider(name, { ...config, encryption: { mode: 'converting', loadKeys } });
  // Closed on every way out: a provider left behind keeps a timer running.
  try {
    const supported =
      typeof base.envelopeDocuments?.sealAtRest === 'function' && typeof base.baseDir === 'string';
    if (!supported) {
      return { action: 'unsupported', enabled, baseDir: null, state: null, report: null };
    }
    const baseDir = base.baseDir;
    const state = await readAtRestState(baseDir);
    const lease = work =>
      dryRun ? work() : withConversionLease(base.locks, { waitMs: leaseWaitMs, signal, say }, work);

    if (!enabled && !force) {
      if (!state || state.state === 'off' || dryRun) {
        return { action: 'none', enabled, baseDir, state, report: null };
      }
      return await lease(async () => {
        const current = await readAtRestState(baseDir);
        if (!current || current.state === 'off') {
          return { action: 'none', enabled, baseDir, state: current, report: null };
        }
        // Before any other write: from here on plaintext is written again.
        const written = await writeAtRestState(baseDir, {
          ...current,
          state: 'off',
          facets: {},
          disabledAt: new Date().toISOString()
        });
        say(
          'info',
          'Storage encryption at rest is off: nothing is converted, new data is written in plaintext, and data encrypted before stays readable with the master key',
          { keyId: written.keyId }
        );
        return { action: 'disabled', enabled, baseDir, state: written, report: null };
      });
    }

    // The master key: present, and still there after a restart. A dry run
    // creates none; an installation without one is reported as such.
    const keys = await loadKeys();
    let keyless = false;
    if (dryRun) {
      const master = await keys.ensureMasterKey({ create: false });
      if (master?.initialized) await checkMasterKey(keys, { create: false });
      else keyless = true;
    } else {
      await checkMasterKey(keys);
    }

    await fs.mkdir(baseDir, { recursive: true }).catch(error => {
      if (!dryRun) throw error;
    });
    return await lease(() =>
      convertUnderLease({
        base,
        baseDir,
        platformConfig,
        env,
        enabled,
        dryRun,
        keyless,
        convertRemoteBlobs,
        signal,
        keys,
        loadKeys,
        say,
        onObject
      })
    );
  } finally {
    await base.shutdown?.().catch(() => {});
  }
}

/**
 * The bucket of a remote blob backend, for the conversion: looked at before
 * anything local is changed, converted (by the command) and recorded after.
 *
 * @param {Object} options
 * @returns {{inspect: () => Promise<Object>, finish: (state: Object) => Promise<{state: Object, aborted: boolean}>,
 *   summary: () => Object|null, close: () => Promise<void>}}
 */
function remoteBlobStep({
  base,
  baseDir,
  blobConfig,
  env,
  loadKeys,
  knownKeyIds,
  adopt,
  dryRun,
  convertRemoteBlobs,
  signal,
  say,
  onObject
}) {
  const backend = createBlobBackend(blobConfig.provider, blobConfig.config, {
    platformConfig: blobConfig.platformConfig,
    locks: base.locks,
    // Plaintext is read here and nowhere else while the switch is on: this is
    // the run that encrypts it.
    encryption: { enabled: true, plaintextReads: 'accept' },
    loadKeys,
    env
  });
  const location = backend.describe?.().location || {};
  const targetId = `${backend.name}:${location.endpointHost || ''}/${location.bucket || ''}/${location.prefix || ''}`;
  const store = backend.blobs;
  let namespaces = Object.values(BLOB_NAMESPACES);
  let found = null;
  let keyCheck = null;
  let summary = null;

  const scan = () => encryptExistingBlobs(store, { namespaces, dryRun: true, signal, knownKeyIds });

  return {
    targetId,
    summary: () => summary,
    close: () => backend.shutdown().catch(() => {}),

    /** Look at the bucket; refuse what a start may not go on with. */
    async inspect(state) {
      if (isRemoteBlobFacetComplete(state, targetId)) {
        summary = { provider: backend.name, target: targetId, status: 'recorded' };
        return summary;
      }
      // Connects (and so loads the key module); an unreachable bucket fails here.
      await store.inner.headBucket?.();
      if (typeof store.inner.namespaces === 'function') {
        namespaces = [...new Set([...namespaces, ...(await store.inner.namespaces())])].sort(
          compareCodeUnits
        );
      }
      keyCheck = await store.verifyKey({ create: false });
      found = await scan();
      summary = {
        provider: backend.name,
        target: targetId,
        status: found.remaining > 0 ? 'plaintext' : 'encrypted',
        scanned: found.scanned,
        plaintext: found.encrypted,
        plaintextBytes: found.plaintextBytes,
        encrypted: found.alreadyEncrypted,
        foreignKey: found.foreign,
        keyCheck: keyCheck.status
      };
      if (found.failed > 0) {
        throw new StorageEncryptionError(
          `${found.failed} blobs in the bucket could not be read while checking whether they are encrypted. See the warnings above.`
        );
      }
      if (found.foreign > 0 && !adopt) {
        throw new StorageEncryptionError(
          `${found.foreign} blobs in the bucket are encrypted with a master key this installation ` +
            'does not hold. Restore the key they were written with (TOKEN_ENCRYPTION_KEY_PREVIOUS ' +
            'after a key change), or use a bucket or prefix of its own for this installation.',
          { code: 'REMOTE_BLOBS_FOREIGN_KEY' }
        );
      }
      if (found.remaining > 0 && !dryRun && !convertRemoteBlobs) {
        throw new StorageEncryptionError(
          `The bucket holds ${found.remaining} blobs that are not encrypted: they were stored ` +
            'while storage encryption was off. With encryption on the server would refuse to ' +
            'read them. Stop every server that uses this bucket and run "npm run ' +
            'storage:encrypt": it encrypts those blobs in the bucket (it can be interrupted and ' +
            'run again) and writes the key check object; then start the server. To go on ' +
            'without encryption instead, set storage.encryption.enabled to false.',
          { code: 'REMOTE_BLOBS_PLAINTEXT' }
        );
      }
      return summary;
    },

    /** Convert (the command), write the key check object, record the facet. */
    async finish(state) {
      if (!found || dryRun) return { state, aborted: false };
      let converted = 0;
      if (found.remaining > 0) {
        say(
          'info',
          `Encrypting ${found.remaining} blobs in the bucket; this reads and writes each of them once`,
          { target: targetId, bytes: found.plaintextBytes }
        );
        const done = await encryptExistingBlobs(store, {
          namespaces,
          signal,
          onProgress: ({ namespace, key }) =>
            onObject?.({ facet: REMOTE_BLOBS_FACET, name: `${namespace}/${key}` })
        });
        if (done.aborted || signal?.aborted) return { state, aborted: true };
        const check = await scan();
        if (done.failed > 0 || check.remaining > 0 || check.aborted) {
          throw new StorageEncryptionError(
            `${check.remaining} blobs in the bucket are still not encrypted after the conversion. ` +
              'See the warnings above for the blobs; correct the cause and run the command again.',
            { code: 'ENCRYPTION_INCOMPLETE' }
          );
        }
        converted = done.encrypted;
        summary = { ...summary, status: 'encrypted', converted };
      }
      // The key check object marks a bucket that holds only blobs of this
      // key. Written when this run encrypted the bucket's blobs, or the
      // bucket is empty. A bucket that already held encrypted blobs and no
      // key check object is still the operator's call (IHUB_S3_ADOPT_BUCKET).
      if (keyCheck.status === 'absent' && (converted > 0 || found.scanned === 0 || adopt)) {
        keyCheck = await store.verifyKey({ create: true });
        summary = { ...summary, keyCheck: keyCheck.status };
      }
      const written = await writeAtRestState(baseDir, {
        ...state,
        facets: { ...state.facets, [REMOTE_BLOBS_FACET]: 1 },
        remoteBlobStore: targetId
      });
      return { state: written, aborted: false };
    }
  };
}

/**
 * Everything of {@link prepareStorageEncryption} that runs under the lease.
 *
 * @param {Object} context
 * @returns {Promise<Object>} What `prepareStorageEncryption` returns.
 */
async function convertUnderLease({
  base,
  baseDir,
  platformConfig,
  env,
  enabled,
  dryRun,
  keyless,
  convertRemoteBlobs,
  signal,
  keys,
  loadKeys,
  say,
  onObject
}) {
  // Read under the lease: a process that waited finds what the other one did.
  let state = await readAtRestState(baseDir);
  const keyProvider = keyless ? null : keys.getKeyProvider();
  const keyId = keyless ? null : await keyProvider.currentKeyId();
  const knownKeyIds = keyless
    ? []
    : typeof keyProvider.knownKeyIds === 'function'
      ? await keyProvider.knownKeyIds()
      : [keyId];

  const blobConfig = resolveBlobStorageConfig(platformConfig, env);
  const remoteBlobs = blobConfig.provider !== 'default';
  // The key check object, and the blobs to convert, through the same
  // encrypting store a server start puts in front of the blob facet.
  const blobs = new EncryptingBlobStore({
    inner: base.blobs,
    encryptWrites: true,
    plaintextReads: 'accept',
    maxBlobBytes: Number.MAX_SAFE_INTEGER,
    keyCheckStore: createLocalKeyCheckStore({ baseDir, legacy: base.blobs }),
    keyProvider: () => {
      if (!keyProvider) throw new Error('there is no master key yet');
      return keyProvider;
    }
  });
  const sealedBefore = recordsSealedData(state);
  const adopt = String(env?.[ADOPT_ENV_VAR] || '').toLowerCase() === 'true';
  const acceptPlaintext = String(env?.[ACCEPT_PLAINTEXT_ENV_VAR] || '').toLowerCase() === 'true';
  const files =
    typeof base.contentsDir === 'string'
      ? createSealedFilesTarget({ contentsDir: base.contentsDir, keyProvider })
      : null;
  const target = {
    documents: base.envelopeDocuments,
    logs: base.logs,
    // Blob files left in the data directory after a move to a bucket are not
    // used any more; they are counted below, not converted.
    blobs: remoteBlobs ? null : blobs,
    // The stores outside the storage layer, in the contents directory this
    // provider belongs to (the parent of a scratch data directory in a test).
    files
  };
  const remote = remoteBlobs
    ? remoteBlobStep({
        base,
        baseDir,
        blobConfig,
        env,
        loadKeys,
        knownKeyIds,
        adopt,
        dryRun,
        convertRemoteBlobs,
        signal,
        say,
        onObject
      })
    : null;

  try {
    // Without a record, the data itself says whether anything was sealed.
    let before = null;
    let sealedOnDisk = sealedBefore;
    if (!state) {
      before = await convertStorage(target, { dryRun: true, signal, knownKeyIds });
      sealedOnDisk = sealedObjects(before) > 0;
    }
    // Proves the key is the one the data was sealed with. Missing although
    // sealed data exists: the data directory was swapped or the object
    // removed, and writing a new one would bless any key. Read only here;
    // it is written below, after the record says `converting`.
    const keyCheck = keyless
      ? { status: 'absent' }
      : await blobs.verifyKey({
          create: false,
          hasOtherObjects: async () => sealedOnDisk && !adopt
        });

    // The record is gone, the sealed data is not: converted, and strict.
    let stateRecordMissing = false;
    if (!state && (keyCheck.status === 'verified' || sealedOnDisk)) {
      stateRecordMissing = true;
      const plaintext = plaintextObjects(before);
      if (plaintext > 0 && !acceptPlaintext) {
        throw new StorageEncryptionError(
          `The encryption state record (${baseDir}/.at-rest.json) is missing, but the data ` +
            `directory holds encrypted data, and ${plaintext} objects in plaintext beside it ` +
            `(${JSON.stringify(plaintextRemaining(before))}). Plaintext is not accepted on such a ` +
            'data directory: it cannot be told from content that was put there afterwards. ' +
            'Restore .at-rest.json from the backup the data came from. Only when you know where ' +
            `the plaintext objects come from: set ${ACCEPT_PLAINTEXT_ENV_VAR}=true for one start ` +
            '(or one run of "npm run storage:encrypt") to encrypt them as they are.',
          { code: 'ENCRYPTION_STATE_MISSING' }
        );
      }
      if (plaintext === 0 && !dryRun) {
        const check = await convertStorage(target, { dryRun: true, verify: true, signal });
        if (plaintextObjects(check) > 0) {
          throw new StorageEncryptionError(
            'The encryption state record is missing and the stored data does not verify: ' +
              `${check.unreadable.join('; ') || 'see the log'}. Restore the data directory from a backup.`,
            { code: 'ENCRYPTION_INCOMPLETE' }
          );
        }
        const now = new Date().toISOString();
        state = await writeAtRestState(baseDir, {
          state: 'complete',
          facets: { ...CURRENT_FACETS },
          keyId,
          startedAt: now,
          completedAt: now,
          recreatedAt: now,
          converted: { documents: 0, streams: 0, spillBlobs: 0, blobs: 0, files: 0 },
          skipped: check.documents.unreadable
        });
        say(
          'warn',
          'The encryption state record was missing although the stored data is encrypted. No plaintext object was found; the record has been written again.',
          { baseDir, keyId }
        );
      } else if (plaintext > 0) {
        say(
          'warn',
          `The encryption state record is missing; ${plaintext} plaintext objects are encrypted as they are because ${ACCEPT_PLAINTEXT_ENV_VAR} is set`,
          { baseDir }
        );
      }
    }

    // Before anything local is changed: a bucket this start may not use.
    const remoteSummary = remote && !keyless ? await remote.inspect(state) : null;

    if (enabled && isConversionComplete(state)) {
      if (state.keyId !== keyId && !dryRun) {
        say(
          'warn',
          'The master key changed since the stored data was encrypted. Data written before needs TOKEN_ENCRYPTION_KEY_PREVIOUS until it is rewritten; do not remove it and do not change the key a second time.',
          { previousKeyId: state.keyId, keyId }
        );
        state = await writeAtRestState(baseDir, { ...state, keyId, previousKeyId: state.keyId });
      }
      // Moves a key check object an earlier build kept in the blob tree, and
      // writes a new one when the operator adopts data whose key check
      // object was lost (rule 4 of `verifyKey`).
      if (!dryRun) {
        await blobs.verifyKey({
          create: adopt,
          adopt,
          migrate: true,
          hasOtherObjects: async () => sealedOnDisk
        });
      }
      if (remote) {
        const finished = await remote.finish(state);
        if (finished.aborted) {
          return { action: 'aborted', enabled, baseDir, state, report: null };
        }
        state = finished.state;
      }
      return {
        action: 'verified',
        enabled,
        baseDir,
        state,
        report: null,
        keyCheck: keyCheck.status,
        remoteBlobs: remote ? remote.summary() : null,
        ...(stateRecordMissing ? { stateRecordMissing } : {})
      };
    }

    before = before || (await convertStorage(target, { dryRun: true, signal, knownKeyIds }));
    const space = await checkFreeSpace(baseDir, before);
    const seconds = estimateSeconds(before);
    const plaintextStores = await plaintextStoresPresent(baseDir);
    // Blob files from before the blobs moved to a bucket: not used, not sealed.
    const localPlaintextBlobs = remoteBlobs
      ? (await convertStorage({ blobs }, { dryRun: true, facets: ['blobs'], signal })).blobs
          .plaintext
      : 0;
    if (dryRun) {
      return {
        action: 'dry-run',
        enabled,
        baseDir,
        state,
        report: before,
        estimateSeconds: seconds,
        plaintextStores,
        keyCheck: keyCheck.status,
        masterKey: keyless ? 'absent' : 'present',
        remoteBlobs: remoteSummary,
        localPlaintextBlobs,
        ...(stateRecordMissing ? { stateRecordMissing } : {}),
        ...space
      };
    }

    // Facets recorded complete stay complete: nothing wrote plaintext since.
    const resumed = state && state.state !== 'off';
    // Three steps, each safe to crash after. The record first, still without
    // a key id: a key check object beside plaintext and no record would read
    // as "converted, record lost". Then the key check object. Then the key
    // id, which from then on says that sealed data exists and that a missing
    // key check object is an error.
    const started = {
      state: 'converting',
      facets: resumed ? state.facets : {},
      ...(resumed && state.remoteBlobStore ? { remoteBlobStore: state.remoteBlobStore } : {}),
      ...(sealedBefore ? { keyId: state.keyId } : {}),
      startedAt: resumed && state.startedAt ? state.startedAt : new Date().toISOString()
    };
    state = await writeAtRestState(baseDir, started);
    await blobs.verifyKey({ create: true, adopt, hasOtherObjects: async () => sealedOnDisk });
    state = await writeAtRestState(baseDir, { ...started, keyId });

    const pending = Object.keys(CURRENT_FACETS).filter(facet => !isFacetComplete(state, facet));
    if (!isEmptyStorage(before)) {
      say(
        'info',
        `Encrypting the stored data (${pending.join(', ')}); the server does not accept requests until this has finished. Estimate on a local disk: about ${seconds} s.`,
        { ...summarize(before), baseDir }
      );
    }

    const startedAt = Date.now();
    let done = 0;
    let lastReport = startedAt;
    const total =
      before.documents.scanned +
      before.streams.scanned +
      before.spillBlobs.scanned +
      before.blobs.scanned +
      before.files.scanned;
    const onProgress = event => {
      done += 1;
      onObject?.(event);
      if (Date.now() - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = Date.now();
      say('info', `Encrypting the stored data: ${done} of about ${total} objects looked at`, {
        elapsedSeconds: Math.round((lastReport - startedAt) / 1000)
      });
    };

    const converted = { documents: 0, streams: 0, spillBlobs: 0, blobs: 0, files: 0 };
    let skipped = 0;
    let last = null;
    for (const facet of pending) {
      if (facet !== 'blobs' || !remoteBlobs) {
        last = await convertStorage(target, {
          facets: [facet],
          signal,
          onProgress,
          removeScratch: true
        });
        if (last.aborted || signal?.aborted) {
          say(
            'warn',
            'The encryption of the stored data was interrupted; the next start continues it'
          );
          return { action: 'aborted', enabled, baseDir, state, report: last };
        }
        // A second walk decides: no plaintext object may be left, and what
        // was sealed has to open (records of every stream are opened).
        const check = await convertStorage(target, {
          facets: [facet],
          dryRun: true,
          verify: true,
          signal
        });
        const left = plaintextRemaining(check)[facet];
        if (left > 0 || check.aborted) {
          throw new StorageEncryptionError(
            `${left} objects of the storage facet "${facet}" are still in plaintext or do not ` +
              'open after the conversion. See the warnings above for the objects' +
              (check.unreadable.length > 0 ? ` (${check.unreadable.join('; ')})` : '') +
              '; correct the cause and start again.',
            { code: 'ENCRYPTION_INCOMPLETE' }
          );
        }
        for (const part of Object.keys(converted)) converted[part] += last[part].plaintext;
        const unreadable = check.documents.unreadable + check.streams.unreadable;
        skipped += unreadable;
        if (unreadable > 0) {
          say(
            'warn',
            `${unreadable} stored objects are not readable in any form and were left as they are`,
            { facet, objects: check.unreadable }
          );
        }
        if (last.tornLines > 0) {
          say('info', 'Removed unfinished lines from append-log streams while encrypting them', {
            lines: last.tornLines
          });
        }
      }
      state = await writeAtRestState(baseDir, {
        ...state,
        facets: { ...state.facets, [facet]: CURRENT_FACETS[facet] }
      });
    }

    state = await writeAtRestState(baseDir, {
      ...state,
      state: 'complete',
      completedAt: new Date().toISOString(),
      converted,
      skipped,
      ...(remoteBlobs ? { plaintextLeftovers: { localBlobs: localPlaintextBlobs } } : {})
    });
    if (remote) {
      const finished = await remote.finish(state);
      if (finished.aborted) {
        say('warn', 'The encryption of the blobs in the bucket was interrupted; run it again');
        return { action: 'aborted', enabled, baseDir, state, report: last };
      }
      state = finished.state;
    }
    const blobsLine = remoteBlobs
      ? `blobs in the bucket (${remote.summary()?.status === 'recorded' ? 'checked before' : `${remote.summary()?.converted || 0} encrypted now`})`
      : 'blobs';
    say(
      'info',
      `Stored data is encrypted at rest: documents, append logs, ${blobsLine}, and the files of agent artifacts, agent memory, agent inboxes, tool-job results and short links. Not covered and still plaintext where present: ` +
        (plaintextStores.length > 0 ? plaintextStores.join(', ') : 'none found') +
        '; earlier backups and volume snapshots.',
      { ...converted, skipped, seconds: Math.round((Date.now() - startedAt) / 1000), keyId }
    );
    if (localPlaintextBlobs > 0) {
      say(
        'warn',
        `${localPlaintextBlobs} blob files from before the blobs moved to the bucket are still in plaintext under ${path.join(baseDir, 'blobs')}. They are not used and were not encrypted; remove that directory once the copy in the bucket is checked.`,
        { localPlaintextBlobs }
      );
    }
    return {
      action: 'converted',
      enabled,
      baseDir,
      state,
      report: last,
      plaintextStores,
      remoteBlobs: remote ? remote.summary() : null,
      localPlaintextBlobs
    };
  } finally {
    await remote?.close();
  }
}
