// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { filenameFromContentDisposition, saveBlobAs } from '../../../utils/externalNavigation';

/**
 * Save the original file of a project document (`item.hasOriginal`) to disk.
 * The user page and the admin page pass their own loader
 * (`fetchProjectItemOriginal` / `fetchAdminProjectItemOriginal`).
 *
 * The name comes from the server's `Content-Disposition`, then the stored
 * original's name, then the item's.
 *
 * A failed request answers with a problem body as a Blob (the request asked for
 * one); it is read back into `response.data`, so `projectErrorMessage` finds its
 * `detail` and `code`.
 *
 * @param {(projectId: string, itemId: string) => Promise<{blob: Blob,
 *   contentDisposition: string|null}>} fetchOriginal
 * @param {string} projectId
 * @param {{id: string, name?: string, original?: {name?: string}}} item
 * @returns {Promise<true>} Resolves once the browser took the download.
 * @throws {Error} The request's error, or one saying the browser did not save the file.
 */
export async function saveItemOriginal(fetchOriginal, projectId, item) {
  let saved;
  try {
    const { blob, contentDisposition } = await fetchOriginal(projectId, item.id);
    const name =
      filenameFromContentDisposition(contentDisposition) ||
      item.original?.name ||
      item.name ||
      'download';
    saved = saveBlobAs(blob, name);
  } catch (error) {
    const response = error?.response;
    if (typeof Blob !== 'undefined' && response?.data instanceof Blob) {
      try {
        response.data = JSON.parse(await response.data.text());
      } catch {
        // Not JSON: the status still tells something.
      }
    }
    throw error;
  }
  if (saved === false) {
    // The file arrived but the browser could not be handed it (no object URLs, a
    // blocked download): an error the pages show, not a silent success.
    throw Object.assign(new Error('The browser could not save the file.'), {
      code: 'DOWNLOAD_NOT_SAVED'
    });
  }
  return true;
}
