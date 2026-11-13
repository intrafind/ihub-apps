// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The per-process project caches of Admin → Projects → Project settings
 * (`platform.projects.indexCache` / `textCache`, #3650). The heap share is
 * shown as a percentage; an empty field is the built-in budget (`null`).
 */

/** Bounds the server takes (`server/services/projects/projectConstants.js`). */
export const INDEX_CACHE_ENTRIES_RANGE = Object.freeze({ min: 1, max: 10000 });
export const HEAP_SHARE_PERCENT_RANGE = Object.freeze({ min: 1, max: 50 });

/** A stored share (0.1) as the text of its percent field ('10'); `null` is ''. */
export function shareToPercentText(share) {
  if (typeof share !== 'number' || !Number.isFinite(share)) return '';
  return String(Math.round(share * 1000) / 10);
}

/**
 * The text of a percent field as a share.
 *
 * @param {string} text
 * @returns {{valid: boolean, share: number|null}} `share` is null for an empty
 *   field (built-in budget); `valid` is false for anything outside 1–50 %.
 */
export function parsePercentShare(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { valid: true, share: null };
  const percent = Number(trimmed);
  if (
    !Number.isFinite(percent) ||
    percent < HEAP_SHARE_PERCENT_RANGE.min ||
    percent > HEAP_SHARE_PERCENT_RANGE.max
  ) {
    return { valid: false, share: null };
  }
  return { valid: true, share: Math.round(percent * 10) / 1000 };
}
