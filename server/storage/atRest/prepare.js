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
 * @module storage/atRest/prepare
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { EncryptingBlobStore } from '../EncryptingBlobStore.js';
import { StorageError } from '../errors.js';
import { createProvider, resolveBlobStorageConfig, resolveStorageConfig } from '../index.js';
import { checkMasterKey } from '../localBlobBackend.js';
import { convertStorage, isEmptyStorage, plaintextRemaining } from './convert.js';
import { createSealedFilesTarget } from './sealedFiles.js';
import {
  CURRENT_FACETS,
  isConversionComplete,
  isFacetComplete,
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
 * `ENCRYPTION_PRECONDITION` (key, free space, key check) and
 * `ENCRYPTION_INCOMPLETE` (plaintext is left after the conversion).
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
 * more, plus the growth of documents and log lines.
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
    report.files.largestBytes
  );
  const growing = report.documents.plaintextBytes + report.streams.plaintextBytes;
  const neededBytes = Math.ceil(largest * 1.35 + growing * GROWTH_SHARE);
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

/**
 * Bring the data directory in line with the encryption switch.
 *
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration (raw file).
 * @param {Object} [options.env=process.env]
 * @param {boolean} [options.dryRun=false] - Report what a conversion would do
 *   and whether its preconditions hold. Writes nothing, not even the record.
 * @param {boolean} [options.force=false] - Convert although the switch is off
 *   (`npm run storage:encrypt` ahead of switching it on).
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
 *   neededBytes?: number, freeBytes?: number|null, plaintextStores?: string[]}>}
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
  const supported =
    typeof base.envelopeDocuments?.sealAtRest === 'function' && typeof base.baseDir === 'string';
  if (!supported) {
    return { action: 'unsupported', enabled, baseDir: null, state: null, report: null };
  }
  const baseDir = base.baseDir;
  let state = await readAtRestState(baseDir);

  if (!enabled && !force) {
    if (!state || state.state === 'off' || dryRun) {
      return { action: 'none', enabled, baseDir, state, report: null };
    }
    // Before any other write: from here on plaintext is written again.
    state = await writeAtRestState(baseDir, {
      ...state,
      state: 'off',
      facets: {},
      disabledAt: new Date().toISOString()
    });
    say(
      'info',
      'Storage encryption at rest is off: nothing is converted, new data is written in plaintext, and data encrypted before stays readable with the master key',
      { keyId: state.keyId }
    );
    return { action: 'disabled', enabled, baseDir, state, report: null };
  }

  // The master key: present, and still there after a restart.
  const keys = await loadKeys();
  await checkMasterKey(keys);
  const keyProvider = keys.getKeyProvider();
  const keyId = await keyProvider.currentKeyId();

  const remoteBlobs = resolveBlobStorageConfig(platformConfig, env).provider !== 'default';
  // The key check object, and the blobs to convert, through the same
  // encrypting store a server start puts in front of the blob facet.
  const blobs = new EncryptingBlobStore({
    inner: base.blobs,
    encryptWrites: true,
    plaintextReads: 'accept',
    maxBlobBytes: Number.MAX_SAFE_INTEGER,
    keyProvider
  });
  const sealedBefore = recordsSealedData(state);
  const adopt = String(env?.[ADOPT_ENV_VAR] || '').toLowerCase() === 'true';
  const target = {
    documents: base.envelopeDocuments,
    logs: base.logs,
    blobs: remoteBlobs ? null : blobs,
    // The stores outside the storage layer, in the contents directory this
    // provider belongs to (the parent of a scratch data directory in a test).
    files:
      typeof base.contentsDir === 'string'
        ? createSealedFilesTarget({ contentsDir: base.contentsDir, keyProvider })
        : null
  };

  try {
    await fs.mkdir(baseDir, { recursive: true });
    // Proves the key is the one the data was sealed with. Missing although
    // the record says sealed data exists: the data directory was swapped or
    // the object removed, and writing a new one would bless any key.
    const keyCheck = await blobs.verifyKey({
      create: !dryRun,
      adopt,
      hasOtherObjects: async () => sealedBefore
    });

    if (enabled && isConversionComplete(state)) {
      if (state.keyId !== keyId && !dryRun) {
        say(
          'warn',
          'The master key changed since the stored data was encrypted. Data written before needs TOKEN_ENCRYPTION_KEY_PREVIOUS until it is rewritten; do not remove it and do not change the key a second time.',
          { previousKeyId: state.keyId, keyId }
        );
        state = await writeAtRestState(baseDir, { ...state, keyId, previousKeyId: state.keyId });
      }
      return {
        action: 'verified',
        enabled,
        baseDir,
        state,
        report: null,
        keyCheck: keyCheck.status
      };
    }

    const before = await convertStorage(target, { dryRun: true, signal });
    const space = await checkFreeSpace(baseDir, before);
    const seconds = estimateSeconds(before);
    const plaintextStores = await plaintextStoresPresent(baseDir);
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
        ...space
      };
    }

    // Facets recorded complete stay complete: nothing wrote plaintext since.
    const resumed = state && state.state !== 'off';
    state = await writeAtRestState(baseDir, {
      state: 'converting',
      facets: resumed ? state.facets : {},
      keyId,
      startedAt: resumed && state.startedAt ? state.startedAt : new Date().toISOString()
    });
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
        last = await convertStorage(target, { facets: [facet], signal, onProgress });
        if (last.aborted || signal?.aborted) {
          say(
            'warn',
            'The encryption of the stored data was interrupted; the next start continues it'
          );
          return { action: 'aborted', enabled, baseDir, state, report: last };
        }
        // A second walk decides: no plaintext object may be left.
        const check = await convertStorage(target, { facets: [facet], dryRun: true, signal });
        const left = plaintextRemaining(check)[facet];
        if (left > 0 || check.aborted) {
          throw new StorageEncryptionError(
            `${left} objects of the storage facet "${facet}" are still in plaintext after the ` +
              'conversion. See the warnings above for the objects; correct the cause and start again.',
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
      skipped
    });
    say(
      'info',
      'Stored data is encrypted at rest: documents, append logs, blobs, and the files of agent artifacts, agent memory, agent inboxes, tool-job results and short links. Not covered and still plaintext where present: ' +
        (plaintextStores.length > 0 ? plaintextStores.join(', ') : 'none found') +
        '; earlier backups and volume snapshots.',
      { ...converted, skipped, seconds: Math.round((Date.now() - startedAt) / 1000), keyId }
    );
    return { action: 'converted', enabled, baseDir, state, report: last, plaintextStores };
  } finally {
    await base.shutdown?.().catch(() => {});
  }
}
