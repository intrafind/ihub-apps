// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The state record of encryption at rest: `<data directory>/.at-rest.json`
 * (`contents/data/.at-rest.json` by default). It says how far the one-time
 * conversion of existing data has come, which is what decides whether
 * plaintext is still read:
 *
 *   { "format": 1,
 *     "state": "off" | "converting" | "complete",
 *     "facets": { "blobs": 1, "documents": 1, "logs": 1, "files": 1 },
 *     "keyId": "1a2b3c4d",
 *     "startedAt": "…", "completedAt": "…", "disabledAt": "…",
 *     "converted": { "documents": 0, "streams": 0, "spillBlobs": 0, "blobs": 0, "files": 0 },
 *     "skipped": 0 }
 *
 * - `facets` lists what is fully encrypted **now**, each with the format
 *   number it was converted to. A facet is added the moment its conversion is
 *   verified, so an interrupted conversion resumes with the next one. A later
 *   release that encrypts more adds a name to {@link CURRENT_FACETS}; an
 *   installation whose record lacks it converts just that.
 * - `state` is `complete` only when every facet of this release is listed.
 *   Switching encryption off writes `off` and clears `facets`, because
 *   plaintext is written again from then on.
 * - `keyId` is the master key the data was sealed with. It stays in the
 *   record when encryption is switched off: sealed data still exists then,
 *   and a missing master key must not be replaced by a new one.
 *
 * The record is not secret and not authenticated. Its integrity is that of
 * `platform.json`, which holds the switch.
 *
 * This module has no dependency on the rest of the storage layer, so the key
 * service can read the record before storage exists.
 *
 * @module storage/atRest/state
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

/** File name of the record, directly in the data directory. */
export const AT_REST_STATE_FILE = '.at-rest.json';

/** Format number of the record. */
export const AT_REST_STATE_FORMAT = 1;

/**
 * What this release encrypts, with the format number of each facet. `files`
 * are the stores outside the storage layer (`./sealedFiles.js`).
 */
export const CURRENT_FACETS = Object.freeze({ blobs: 1, documents: 1, logs: 1, files: 1 });

/** The states a record can be in. */
export const AT_REST_STATES = Object.freeze(['off', 'converting', 'complete']);

/** The record does not read as one. */
export class AtRestStateError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {unknown} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AtRestStateError';
    this.code = 'INVALID_AT_REST_STATE';
  }
}

/**
 * Absolute path of the record of a data directory.
 *
 * @param {string} baseDir - The storage provider's base directory.
 * @returns {string}
 */
export function atRestStatePath(baseDir) {
  return path.join(baseDir, AT_REST_STATE_FILE);
}

/**
 * Read the record.
 *
 * @param {string} baseDir - The storage provider's base directory.
 * @returns {Promise<Object|null>} The record; null when there is none (an
 *   installation that never had encryption on).
 * @throws {AtRestStateError} When the file exists and is not a record. Never
 *   read as "none": that would treat encrypted data as an empty installation.
 */
export async function readAtRestState(baseDir) {
  let raw;
  try {
    raw = await fs.readFile(atRestStatePath(baseDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw new AtRestStateError(
      `The encryption state record ${atRestStatePath(baseDir)} cannot be read: ${error.message}`,
      { cause: error }
    );
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (cause) {
    throw new AtRestStateError(
      `The encryption state record ${atRestStatePath(baseDir)} is not JSON. Restore it from a backup.`,
      { cause }
    );
  }
  if (
    !state ||
    typeof state !== 'object' ||
    state.format !== AT_REST_STATE_FORMAT ||
    !AT_REST_STATES.includes(state.state)
  ) {
    throw new AtRestStateError(
      `The encryption state record ${atRestStatePath(baseDir)} is not in a format this release knows.`
    );
  }
  const facets = {};
  if (state.facets && typeof state.facets === 'object') {
    for (const [name, format] of Object.entries(state.facets)) {
      if (Number.isInteger(format) && format > 0) facets[name] = format;
    }
  }
  return { ...state, facets };
}

/**
 * Write the record, atomically.
 *
 * @param {string} baseDir - The storage provider's base directory.
 * @param {Object} state - The record without `format`.
 * @returns {Promise<Object>} The record as written.
 */
export async function writeAtRestState(baseDir, state) {
  const record = { ...state, format: AT_REST_STATE_FORMAT };
  await fs.mkdir(baseDir, { recursive: true });
  await atomicWriteJSON(atRestStatePath(baseDir), record);
  return record;
}

/**
 * Whether a facet is recorded as fully encrypted at this release's format.
 *
 * @param {Object|null} state
 * @param {string} facet - `blobs`, `documents`, `logs` or `files`.
 * @returns {boolean}
 */
export function isFacetComplete(state, facet) {
  if (!state || state.state === 'off') return false;
  return (state.facets?.[facet] ?? 0) >= (CURRENT_FACETS[facet] ?? Infinity);
}

/**
 * The facets of this release a record does not list yet.
 *
 * @param {Object|null} state
 * @returns {string[]}
 */
export function missingFacets(state) {
  return Object.keys(CURRENT_FACETS).filter(facet => !isFacetComplete(state, facet));
}

/**
 * Whether the conversion is recorded complete for everything this release
 * encrypts.
 *
 * @param {Object|null} state
 * @returns {boolean}
 */
export function isConversionComplete(state) {
  return state?.state === 'complete' && missingFacets(state).length === 0;
}

/**
 * Whether a record says that sealed data exists (or existed): it names the
 * master key the data was sealed with.
 *
 * @param {Object|null} state
 * @returns {boolean}
 */
export function recordsSealedData(state) {
  return typeof state?.keyId === 'string' && state.keyId.length > 0;
}
