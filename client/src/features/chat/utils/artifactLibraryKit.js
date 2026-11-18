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
    const pending = import('../../../api').then(api => api.fetchArtifactLibrarySource(id));
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

/**
 * The markup with the kit libraries it asks for inlined. Markup without a
 * marker, and all markup while the kit is off, comes back unchanged. A library
 * that cannot be fetched is left out (its marker removed), so the page runs
 * without it rather than not at all.
 *
 * @param {string} html
 * @param {{ enabled?: boolean }} [kit] - On unless `enabled: false`.
 * @returns {Promise<string>}
 */
export async function withArtifactLibraries(html, kit) {
  if (kit?.enabled === false || !hasArtifactLibraryMarker(html)) return html;
  const ids = requestedArtifactLibraries(html);
  const loaded = new Map();
  await Promise.all(
    ids.map(async id => {
      try {
        loaded.set(id, await librarySource(id));
      } catch {
        // Left out: see above.
      }
    })
  );
  return inlineArtifactLibraries(html, id => loaded.get(id)).html;
}

/**
 * A file as the user saves or attaches it: an `.html` file with kit markers
 * gets the libraries inlined, so it works opened from disk. Every other file
 * is the blob it was.
 *
 * @param {Blob} blob
 * @param {string} name - The file name.
 * @param {{ enabled?: boolean }} [kit]
 * @returns {Promise<Blob>}
 */
export async function downloadableArtifactBlob(blob, name, kit) {
  if (!blob || kit?.enabled === false || !/\.html?$/i.test(String(name || ''))) return blob;
  const text = await blob.text();
  if (!hasArtifactLibraryMarker(text)) return blob;
  const expanded = await withArtifactLibraries(text, kit);
  return expanded === text ? blob : new Blob([expanded], { type: blob.type || 'text/html' });
}
