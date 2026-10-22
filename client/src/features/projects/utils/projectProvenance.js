// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a project item's text came from, as the item table and the citation
 * cards show it (#1036, spec 1 §3, spec 2 §5): *Uploaded*, *Picked from
 * SharePoint · text taken 12 Oct 2026*, *Linked*.
 *
 * `provenance.origin` maps onto three markers: `uploaded` and `written`
 * render as uploaded, `picked` as picked from the source system, `linked`
 * and `migrated` as linked.
 *
 * @module features/projects/utils/projectProvenance
 */

/** The source system a picked item's kind reads from. */
export const PICKED_SITE_BY_KIND = Object.freeze({
  office365: 'OneDrive / SharePoint',
  'google-drive': 'Google Drive',
  nextcloud: 'Nextcloud'
});

/** Origin → the marker it renders as. */
const MARKER_BY_ORIGIN = Object.freeze({
  uploaded: 'uploaded',
  written: 'uploaded',
  picked: 'picked',
  linked: 'linked',
  migrated: 'linked'
});

/**
 * What the provenance chip shows.
 *
 * @param {{origin?: string, kind?: string, at?: string, source?: {site?: string}}|null} provenance -
 *   A `Source.provenance` (`{ origin, kind, at }`) or an item's provenance
 *   (`{ origin, by, at, source }`).
 * @param {{kind?: string, snapshotAt?: string|null}} [item] - The item, when
 *   the provenance belongs to one (its kind and snapshot date).
 * @returns {{marker: 'uploaded'|'picked'|'linked', site: string|null, at: string|null}|null}
 *   `null` without a known origin.
 *
 * @example
 * provenanceView({ origin: 'picked', kind: 'office365', at: '2026-10-12T08:00:00Z' })
 * // => { marker: 'picked', site: 'OneDrive / SharePoint', at: '2026-10-12T08:00:00Z' }
 */
export function provenanceView(provenance, item = {}) {
  const marker = MARKER_BY_ORIGIN[provenance?.origin];
  if (!marker) return null;
  if (marker !== 'picked') return { marker, site: null, at: null };
  const kind = provenance.kind || item.kind;
  const site = provenance.source?.site || PICKED_SITE_BY_KIND[kind] || null;
  const at = item.snapshotAt || provenance.at || null;
  return { marker, site, at };
}

/**
 * A snapshot date in the user's language ("12 Oct 2026"), or null when it
 * does not parse.
 *
 * @param {string|null} value - ISO date.
 * @param {string} [language]
 * @returns {string|null}
 */
export function formatSnapshotDate(value, language) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language || undefined, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
