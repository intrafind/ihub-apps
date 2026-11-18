// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  hasArtifactLibraryMarker,
  inlineArtifactLibraries,
  requestedArtifactLibraries
} from '../../../../../shared/artifactLibraries.js';

/**
 * The browser side of the library kit for HTML artifacts (#3822): an HTML
 * artifact asks for a kit library with `<script data-ihub-lib="chart.js">`,
 * and before the markup runs in the preview, or leaves as a download, the
 * marker is replaced with the library's source (`shared/artifactLibraries.js`
 * does the replacing; this module fetches the sources once per page).
 */

// id -> Promise<string>; a failed fetch is forgotten so a later preview retries.
const sources = new Map();

function librarySource(id) {
  if (!sources.has(id)) {
    // Loaded on first use: a preview without a marker never pulls in the API client.
    const pending = import('../../../api')
      .then(api => api.fetchArtifactLibrarySource(id))
      .then(text => {
        // An empty answer is a failure too, so it is not kept for the page.
        if (!text) throw new Error(`Empty source for ${id}`);
        return text;
      });
    pending.catch(() => sources.delete(id));
    sources.set(id, pending);
  }
  return sources.get(id);
}

/** Forget the fetched sources (tests). */
export function resetArtifactLibraryCache() {
  sources.clear();
}

/**
 * Whether the kit is on, from the platform config the client got. A server
 * that does not send `artifacts.libraryKit` has no kit, so off.
 *
 * @param {Object} [platformConfig]
 * @returns {{ enabled: boolean }}
 */
export function libraryKitOf(platformConfig) {
  return { enabled: platformConfig?.artifacts?.libraryKit?.enabled === true };
}

/** The error a download or attachment raises when a library it needs could not be fetched. */
export class ArtifactLibraryUnavailableError extends Error {
  constructor(missing) {
    super(`The library kit could not provide: ${missing.join(', ')}`);
    this.name = 'ArtifactLibraryUnavailableError';
    this.code = 'library-unavailable';
    this.missing = missing;
  }
}

/** Inline what the kit provides; report what it could not. */
async function inlineWithReport(html, kit) {
  if (kit?.enabled === false || !hasArtifactLibraryMarker(html)) {
    return { html, inlined: [], missing: [] };
  }
  const ids = requestedArtifactLibraries(html);
  const loaded = new Map();
  await Promise.all(
    ids.map(async id => {
      try {
        loaded.set(id, await librarySource(id));
      } catch {
        // Reported as missing by the inliner.
      }
    })
  );
  return inlineArtifactLibraries(html, id => loaded.get(id));
}

/**
 * The markup with the kit libraries it asks for inlined, for the preview.
 * Markup without a marker, and all markup while the kit is off, comes back
 * unchanged. A library that cannot be fetched is left out (its marker
 * removed): the preview runs without it rather than not at all.
 *
 * @param {string} html
 * @param {{ enabled?: boolean }} [kit] - On unless `enabled: false`.
 * @returns {Promise<string>}
 */
export async function withArtifactLibraries(html, kit) {
  return (await inlineWithReport(html, kit)).html;
}

/**
 * A file as the user saves or attaches it: an `.html` file with kit markers
 * gets the libraries inlined, so it works opened from disk. Every other file
 * is the blob it was. Unlike the preview, a file is never handed over with a
 * library missing: that throws {@link ArtifactLibraryUnavailableError}, and
 * the action can be tried again.
 *
 * @param {Blob} blob
 * @param {string} name - The file name.
 * @param {{ enabled?: boolean }} [kit]
 * @returns {Promise<Blob>}
 * @throws {ArtifactLibraryUnavailableError}
 */
export async function downloadableArtifactBlob(blob, name, kit) {
  const fileName = String(name || '').trim();
  if (!blob || kit?.enabled === false || !/\.html?$/i.test(fileName)) return blob;
  const text = await blob.text();
  if (!hasArtifactLibraryMarker(text)) return blob;
  const { html, missing } = await inlineWithReport(text, kit);
  if (missing.length) throw new ArtifactLibraryUnavailableError(missing);
  return html === text ? blob : new Blob([html], { type: blob.type || 'text/html' });
}
