// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The decisions of encryption at rest that depend on the switch
 * (`storage.encryption.enabled`) and the state record
 * (`storage/atRest/state.js`), in one place.
 *
 * | Switch | State record | Documents and logs | Filesystem blobs |
 * | --- | --- | --- | --- |
 * | off | any | `off`: plaintext written, sealed data still read | plaintext written, encrypted still read |
 * | on | `complete` | `enforced`: sealed, plaintext is an error | encrypted, plaintext is an error |
 * | on | anything else, in the preparing process | `converting`: sealed, both read | encrypted, both read |
 * | on | anything else, in any other process | refuse to start | |
 *
 * "The preparing process" is the one that runs before the workers exist: the
 * cluster primary or the single process, from the start of the configuration
 * migrations to the end of the conversion ({@link beginAtRestPreparation}).
 * Only there may plaintext and sealed data be read side by side.
 *
 * @module storage/atRest/policy
 */
import { isConversionComplete, isFacetComplete, recordsSealedData } from './state.js';

let preparing = false;

/**
 * Mark this process as the one that prepares the data directory. A storage
 * provider started from now on (a configuration migration does that) reads
 * plaintext and sealed data while the conversion has not completed.
 *
 * @returns {void}
 */
export function beginAtRestPreparation() {
  preparing = true;
}

/**
 * End the preparation: from now on an unfinished conversion refuses a start.
 *
 * @returns {void}
 */
export function endAtRestPreparation() {
  preparing = false;
}

/**
 * Whether this process is preparing the data directory.
 *
 * @returns {boolean}
 */
export function isAtRestPreparation() {
  return preparing;
}

/**
 * The mode of the document store and the append log.
 *
 * @param {Object} options
 * @param {boolean} options.enabled - The switch.
 * @param {Object|null} options.state - The state record.
 * @param {boolean} [options.preparing] - Defaults to {@link isAtRestPreparation}.
 * @returns {'off'|'converting'|'enforced'|null} Null when the process must
 *   refuse to start: encryption is on and the conversion has not completed.
 */
export function decideAtRestMode({ enabled, state, preparing: inPreparation = preparing }) {
  if (!enabled) return 'off';
  if (isConversionComplete(state)) return 'enforced';
  return inPreparation ? 'converting' : null;
}

/**
 * What a read of the filesystem blob store does with a plaintext blob.
 *
 * @param {Object} options
 * @param {boolean} options.enabled - The switch.
 * @param {boolean} options.remote - Whether the blobs are on a remote backend
 *   (S3). Strict whenever the switch is on: a start only gets this far when
 *   the preparation step found no plaintext blob in the bucket, and a bucket
 *   that holds some is converted by `npm run storage:encrypt`, which is the
 *   one place that reads them (`storage/atRest/prepare.js`).
 * @param {Object|null} options.state - The state record.
 * @returns {'reject'|'accept'}
 */
export function blobPlaintextReads({ enabled, remote, state }) {
  if (!enabled) return 'accept';
  if (remote) return 'reject';
  return isFacetComplete(state, 'blobs') ? 'reject' : 'accept';
}

/**
 * What an administrator is told about encryption at rest.
 *
 * @param {Object} options
 * @param {boolean} options.enabled - The switch.
 * @param {'off'|'converting'|'enforced'|null} options.mode - Mode of
 *   documents and logs; null for a provider that does not encrypt them.
 * @param {Object|null} options.state - The state record.
 * @returns {{enabled: boolean, scope: 'none'|'blobs'|'storage',
 *   conversion: {state: 'none'|'off'|'converting'|'complete', facets: Record<string, number>,
 *   keyId: string|null, skipped: number, completedAt: string|null},
 *   sealedDataExists: boolean}}
 *   `scope`: `storage` when documents, append logs and blobs are encrypted,
 *   `blobs` when only blobs are, `none` when nothing is written encrypted.
 */
export function describeEncryption({ enabled, mode, state }) {
  let scope = 'none';
  if (enabled) scope = mode === 'enforced' || mode === 'converting' ? 'storage' : 'blobs';
  return {
    enabled,
    scope,
    conversion: {
      state: state?.state || 'none',
      facets: { ...(state?.facets || {}) },
      keyId: state?.keyId || null,
      skipped: Number.isInteger(state?.skipped) ? state.skipped : 0,
      completedAt: state?.completedAt || null
    },
    sealedDataExists: recordsSealedData(state)
  };
}
