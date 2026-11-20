// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one-time conversion of existing data to its encrypted form: documents,
 * append-log streams with their spill blobs, blobs, and the files of the
 * stores outside the storage layer (`./sealedFiles.js`).
 *
 * Used by the start-up step (`./prepare.js`) and by `npm run storage:encrypt`.
 * **It runs while nothing else writes**: before the workers exist, or with
 * the server stopped. Between reading a plaintext blob and writing its
 * ciphertext there is no compare-and-set.
 *
 * It keeps no progress file. Every object is recognised by its own format
 * (envelope version 3, a `$enc` line, the blob envelope magic), so a run that
 * was interrupted is simply run again and skips what is done. Every object is
 * replaced in one rename: after a crash it is plaintext or sealed, never a
 * mix.
 *
 * The stores do the work on one object (`sealAtRest`, `sealStreamFile`,
 * `sealSpillDir`, `encryptExistingBlobs`); this module walks, bounds the
 * concurrency and counts. A dry run takes the same walk and writes nothing.
 *
 * @module storage/atRest/convert
 */
import { encryptExistingBlobs } from '../encryptExistingBlobs.js';
import { BLOB_NAMESPACES } from '../namespaces.js';
import { compareCodeUnits } from '../../../shared/toolApproval.js';

/** Objects in flight at once, like the document store's read concurrency. */
export const CONVERT_CONCURRENCY = 16;

/** Unreadable objects named in a report; the rest are only counted. */
const MAX_NAMED = 20;

/**
 * @typedef {Object} FacetCount
 * @property {number} scanned - Objects looked at.
 * @property {number} plaintext - Objects found in plaintext: sealed by this
 *   run, or in a dry run still to be sealed.
 * @property {number} sealed - Objects that were sealed before.
 * @property {number} unreadable - Objects that are not readable in either
 *   form (a torn file). Left as they are.
 * @property {number} failed - Objects that could not be sealed (an I/O error).
 * @property {number} plaintextBytes - Stored bytes of the plaintext objects.
 * @property {number} largestBytes - Size of the largest plaintext object.
 */

/**
 * @typedef {Object} ConversionReport
 * @property {boolean} dryRun
 * @property {boolean} aborted - Stopped by the signal before the end.
 * @property {FacetCount} documents
 * @property {FacetCount} streams - Stream files; `plaintext` counts files
 *   that held at least one plaintext record.
 * @property {FacetCount} spillBlobs
 * @property {FacetCount} blobs
 * @property {FacetCount} files - Files of the stores outside the storage layer.
 * @property {number} records - Plaintext log records, over all streams.
 * @property {number} sealedRecords - Sealed log records, over all streams.
 * @property {number} tornLines - Log lines that are no record (dropped when
 *   their stream is rewritten).
 * @property {string[]} unreadable - The first unreadable objects, by name.
 */

function emptyCount() {
  return {
    scanned: 0,
    plaintext: 0,
    sealed: 0,
    unreadable: 0,
    failed: 0,
    plaintextBytes: 0,
    largestBytes: 0
  };
}

/**
 * Run `work` over `items`, at most `limit` at once, stopping at the signal.
 *
 * @param {Array} items
 * @param {number} limit
 * @param {AbortSignal|undefined} signal
 * @param {(item: any) => Promise<void>} work
 * @returns {Promise<boolean>} False when the signal stopped it.
 */
async function eachLimited(items, limit, signal, work) {
  let next = 0;
  let failure = null;
  const run = async () => {
    while (next < items.length && !failure && !signal?.aborted) {
      const item = items[next];
      next += 1;
      try {
        await work(item);
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (failure) throw failure;
  return !signal?.aborted;
}

/**
 * How many plaintext objects a report says are still there after its run, per
 * facet of the state record. After a conversion that is what failed; after a
 * dry run it is everything that would be converted.
 *
 * @param {ConversionReport} report
 * @returns {{blobs: number, documents: number, logs: number, files: number}}
 */
export function plaintextRemaining(report) {
  const left = count => count.failed + (report.dryRun ? count.plaintext : 0);
  return {
    blobs: left(report.blobs),
    documents: left(report.documents),
    logs: left(report.streams) + left(report.spillBlobs),
    files: left(report.files)
  };
}

/**
 * Whether a report found nothing at all: an installation without runtime data.
 *
 * @param {ConversionReport} report
 * @returns {boolean}
 */
export function isEmptyStorage(report) {
  return (
    report.documents.scanned +
      report.streams.scanned +
      report.spillBlobs.scanned +
      report.blobs.scanned +
      report.files.scanned ===
    0
  );
}

/**
 * Seal what is stored in plaintext, or count it.
 *
 * @param {Object} target - The stores to walk; a missing one is skipped.
 * @param {Object} [target.documents] - The enveloped document store of the
 *   filesystem provider, in a mode that seals its writes.
 * @param {Object} [target.logs] - Its append log.
 * @param {Object} [target.blobs] - An encrypting blob store that encrypts its
 *   writes and accepts plaintext reads (`EncryptingBlobStore`).
 * @param {Object} [target.files] - The stores outside the storage layer
 *   (`createSealedFilesTarget` of `./sealedFiles.js`).
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - Count only, write nothing.
 * @param {string[]} [options.facets] - `blobs`, `documents`, `logs`, `files`; all by default.
 * @param {AbortSignal} [options.signal] - Stop before the next object.
 * @param {(event: {facet: string, name: string}) => void} [options.onProgress] -
 *   Called once per object.
 * @param {number} [options.concurrency=16]
 * @param {boolean} [options.verify=false] - With `dryRun`: open records of
 *   every append-log stream instead of only counting its lines (see
 *   `inspectStreamFile`); what does not open is counted in `streams.failed`.
 *   The pass that decides whether a facet is recorded complete asks for it.
 * @param {boolean} [options.removeScratch=false] - Remove scratch files an
 *   interrupted conversion left in the log tree. Only under the conversion lease.
 * @param {Iterable<string>} [options.knownKeyIds] - Master key ids held here;
 *   encrypted blobs naming another are counted in `blobs.foreign`.
 * @returns {Promise<ConversionReport>}
 * @throws {import('../errors.js').KeyUnavailableError} When a data key cannot
 *   be wrapped. What was sealed until then stays sealed.
 *
 * @example
 * const report = await convertStorage({ documents, logs, blobs }, { dryRun: true });
 * plaintextRemaining(report); // { blobs: 3, documents: 120, logs: 14, files: 2 }
 */
export async function convertStorage(
  { documents = null, logs = null, blobs = null, files = null } = {},
  {
    dryRun = false,
    facets = ['blobs', 'documents', 'logs', 'files'],
    signal,
    onProgress,
    concurrency = CONVERT_CONCURRENCY,
    verify = false,
    removeScratch = false,
    knownKeyIds = null
  } = {}
) {
  /** @type {ConversionReport} */
  const report = {
    dryRun,
    aborted: false,
    documents: emptyCount(),
    streams: emptyCount(),
    spillBlobs: emptyCount(),
    blobs: emptyCount(),
    files: emptyCount(),
    records: 0,
    sealedRecords: 0,
    tornLines: 0,
    unreadable: []
  };
  const name = text => {
    if (report.unreadable.length < MAX_NAMED) report.unreadable.push(text);
  };
  const plain = (count, bytes) => {
    count.plaintext += 1;
    count.plaintextBytes += bytes;
    count.largestBytes = Math.max(count.largestBytes, bytes);
  };

  if (blobs && facets.includes('blobs')) {
    const inner = blobs.inner;
    const found = typeof inner?.namespaces === 'function' ? await inner.namespaces() : [];
    const namespaces = [...new Set([...Object.values(BLOB_NAMESPACES), ...found])].sort(
      compareCodeUnits
    );
    // An overwrite by the conversion is not a new blob: keep its age.
    if (!dryRun && inner && 'keepModificationTime' in inner) inner.keepModificationTime = true;
    try {
      const result = await encryptExistingBlobs(blobs, {
        namespaces,
        dryRun,
        signal,
        knownKeyIds,
        onProgress: ({ namespace, key }) =>
          onProgress?.({ facet: 'blobs', name: `${namespace}/${key}` })
      });
      report.blobs.scanned = result.scanned;
      report.blobs.plaintext = result.encrypted;
      report.blobs.sealed = result.alreadyEncrypted;
      report.blobs.failed = result.failed;
      report.blobs.plaintextBytes = result.plaintextBytes;
      report.blobs.largestBytes = result.largestBytes;
      report.blobs.foreign = result.foreign;
      if (result.aborted) report.aborted = true;
    } finally {
      if (!dryRun && inner && 'keepModificationTime' in inner) inner.keepModificationTime = false;
    }
  }

  if (documents && facets.includes('documents') && !report.aborted) {
    const count = report.documents;
    for (const ns of await documents.atRestNamespaces()) {
      const keys = await documents.atRestKeys(ns);
      const finished = await eachLimited(keys, concurrency, signal, async key => {
        count.scanned += 1;
        const found = await documents.inspectAtRest(ns, key);
        let state = found.state;
        if (state === 'plain' && !dryRun) {
          const outcome = await documents.sealAtRest(ns, key);
          state = outcome === 'sealed' ? 'plain' : outcome === 'already' ? 'sealed' : outcome;
        }
        if (state === 'plain') plain(count, found.bytes);
        else if (state === 'sealed') count.sealed += 1;
        else if (state === 'unreadable') {
          count.unreadable += 1;
          name(`document ${ns}/${key}`);
        } else count.scanned -= 1; // deleted since it was listed
        onProgress?.({ facet: 'documents', name: `${ns}/${key}` });
      });
      if (!finished) {
        report.aborted = true;
        break;
      }
    }
  }

  if (logs && facets.includes('logs') && !report.aborted) {
    const targets = await logs.atRestTargets({ removeScratch: removeScratch && !dryRun });
    const streamsDone = await eachLimited(targets.streams, concurrency, signal, async file => {
      const count = report.streams;
      count.scanned += 1;
      const found = dryRun
        ? await logs.inspectStreamFile(file, { verify })
        : await logs.sealStreamFile(file);
      report.records += found.plain;
      report.sealedRecords += found.sealed;
      report.tornLines += found.torn;
      if (found.damaged > 0) {
        count.failed += 1;
        name(`stream ${file} (${found.damaged} records or key lines do not open)`);
      }
      if (found.plain > 0) plain(count, found.bytes ?? 0);
      else count.sealed += 1;
      onProgress?.({ facet: 'logs', name: file });
    });
    const blobsDone =
      streamsDone &&
      (await eachLimited(targets.blobDirs, 2, signal, async dir => {
        const count = report.spillBlobs;
        const found = dryRun ? await logs.inspectSpillDir(dir) : await logs.sealSpillDir(dir);
        count.scanned += found.plain + found.sealed;
        count.plaintext += found.plain;
        count.sealed += found.sealed;
        count.plaintextBytes += found.bytes ?? 0;
        count.largestBytes = Math.max(count.largestBytes, found.largest ?? 0);
        onProgress?.({ facet: 'logs', name: dir });
      }));
    if (!blobsDone) report.aborted = true;
  }

  if (files && facets.includes('files') && !report.aborted) {
    const count = report.files;
    const finished = await eachLimited(await files.list(), concurrency, signal, async entry => {
      const found = await files.inspect(entry);
      let state = found.state;
      if (state === 'plain' && !dryRun) {
        const outcome = await files.seal(entry);
        state = outcome === 'sealed' ? 'plain' : outcome === 'already' ? 'sealed' : outcome;
      }
      if (state === 'plain') plain(count, found.bytes);
      else if (state === 'sealed') count.sealed += 1;
      // Anything else: deleted since it was listed.
      if (state === 'plain' || state === 'sealed') count.scanned += 1;
      onProgress?.({ facet: 'files', name: `${entry.store}/${entry.name}` });
    });
    if (!finished) report.aborted = true;
  }

  return report;
}
