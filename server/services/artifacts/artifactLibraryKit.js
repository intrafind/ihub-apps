// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The server side of the library kit for HTML artifacts (#3822): reads the
 * vendored library files and inlines them where markup leaves the server to
 * run or to be saved (the share embed page, a share download, a ZIP).
 *
 * A file is read from `server/artifactLibraries/` only by the name the kit's
 * manifest gives it (`shared/artifactLibraries.js`); a marker's value is
 * matched against the manifest and never becomes a path. Each file is checked
 * against its recorded size and SHA-256 on first read; a file that does not
 * match is treated as missing and logged, so a damaged or swapped file is
 * never served.
 *
 * @module services/artifacts/artifactLibraryKit
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';
import {
  ARTIFACT_LIBRARIES,
  artifactLibraryById,
  hasArtifactLibraryMarker,
  inlineArtifactLibraries
} from '../../../shared/artifactLibraries.js';
import { artifactPolicy } from './artifactPolicy.js';

/** Directory of the vendored files. */
export function artifactLibraryDir() {
  return path.join(getRootDir(), 'server', 'artifactLibraries');
}

// id -> verified source. A file that is missing or does not match is not
// cached for good: it is tried again after RETRY_MS, so restoring the file
// takes effect without a restart.
const cache = new Map();
const failedAt = new Map();
const RETRY_MS = 60 * 1000;

/**
 * The verified source of a kit library, or null.
 *
 * @param {string} id - A kit id (`chart.js`, `d3`, `alpinejs`).
 * @returns {string|null}
 */
export function artifactLibrarySource(id) {
  const library = artifactLibraryById(id);
  if (!library) return null;
  if (cache.has(library.id)) return cache.get(library.id);
  if (Date.now() - (failedAt.get(library.id) ?? -Infinity) < RETRY_MS) return null;
  let source = null;
  try {
    const data = readFileSync(path.join(artifactLibraryDir(), library.file));
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (data.length === library.bytes && sha256 === library.sha256) {
      source = data.toString('utf8');
    } else {
      logger.error('Artifact library file does not match the kit manifest', {
        component: 'ArtifactLibraryKit',
        library: library.id,
        bytes: data.length,
        sha256
      });
    }
  } catch (error) {
    logger.error('Artifact library file could not be read', {
      component: 'ArtifactLibraryKit',
      library: library.id,
      error: error.message
    });
  }
  if (source === null) failedAt.set(library.id, Date.now());
  else {
    cache.set(library.id, source);
    failedAt.delete(library.id);
  }
  return source;
}

/**
 * Read and verify every kit file once, at startup, so that no request pays
 * for the first (synchronous) read of about half a megabyte.
 */
export function warmArtifactLibraries() {
  for (const library of ARTIFACT_LIBRARIES) artifactLibrarySource(library.id);
}

/**
 * The kit as the API and the admin page describe it.
 *
 * @returns {Array<{id: string, name: string, version: string, global: string, use: string,
 *   license: string, homepage: string, bytes: number, sha256: string, available: boolean}>}
 */
export function artifactLibraryList() {
  return ARTIFACT_LIBRARIES.map(library => ({
    id: library.id,
    name: library.name,
    version: library.version,
    global: library.global,
    use: library.use,
    license: library.license,
    homepage: library.homepage,
    bytes: library.bytes,
    sha256: library.sha256,
    available: artifactLibrarySource(library.id) !== null
  }));
}

/**
 * Inline the kit libraries an HTML document asks for, when the kit is on.
 * Text without a marker, and every document while the kit is off, is
 * returned as it is.
 *
 * @param {string} html
 * @param {{enabled?: boolean}} [kit] - `artifactSettings(platform).libraryKit`; the live policy by default.
 * @returns {string}
 */
export function inlineKitLibraries(html, kit = artifactPolicy().libraryKit) {
  if (kit?.enabled === false || !hasArtifactLibraryMarker(html)) return html;
  return inlineArtifactLibraries(html, artifactLibrarySource).html;
}

/**
 * The bytes of an HTML artifact as they are saved or run outside the store:
 * with the kit libraries inlined. Anything that is not an `.html` file, or
 * has no marker, is returned unchanged (the same Buffer).
 *
 * @param {Buffer} data
 * @param {string} [name] - The artifact's file name.
 * @param {{enabled?: boolean}} [kit]
 * @returns {Buffer}
 */
export function withKitLibraries(data, name, kit) {
  if (!Buffer.isBuffer(data) || !/\.html?$/i.test(String(name || ''))) return data;
  if (!data.includes('data-ihub-lib')) return data;
  const text = data.toString('utf8');
  const expanded = inlineKitLibraries(text, kit);
  return expanded === text ? data : Buffer.from(expanded, 'utf8');
}
