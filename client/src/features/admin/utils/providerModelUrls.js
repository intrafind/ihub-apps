// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a provider save did to the API URLs of its linked models.
 *
 * `PUT /api/admin/providers/{id}` answers `modelUrls: { updated, skipped }`
 * when the provider's base URL changed: `updated` are the ids of the linked
 * models the server moved to the new base URL, `skipped` the linked models it
 * left alone (`{ id, url }`) because their URL does not start with the old
 * base URL. The provider edit page reports both.
 *
 * @module features/admin/utils/providerModelUrls
 */

/**
 * The URL changes worth reporting, or `null` when the save touched no linked
 * model's URL (no base URL change, or no linked model with a URL).
 *
 * @param {unknown} modelUrls - `modelUrls` of the PUT response; anything else is ignored
 * @returns {{ updated: string[], skipped: Array<{ id: string, url: string }> }|null}
 * @example
 * summarizeModelUrlChanges({ updated: ['a'], skipped: [] }) // => { updated: ['a'], skipped: [] }
 * summarizeModelUrlChanges({ updated: [], skipped: [] })    // => null
 */
export function summarizeModelUrlChanges(modelUrls) {
  if (!modelUrls || typeof modelUrls !== 'object') return null;
  const updated = Array.isArray(modelUrls.updated)
    ? modelUrls.updated.filter(id => typeof id === 'string')
    : [];
  const skipped = Array.isArray(modelUrls.skipped)
    ? modelUrls.skipped.filter(entry => entry && typeof entry.id === 'string')
    : [];
  if (updated.length === 0 && skipped.length === 0) return null;
  return { updated, skipped };
}
