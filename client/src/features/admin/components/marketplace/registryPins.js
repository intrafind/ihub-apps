// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The version pins of a marketplace registry (versioning phase 3) as the
 * registry dialog edits them: `pins` in the registry config is
 * `{ '<type>:<name>': '<semver range>' }`; the dialog shows one row per pin.
 * The server checks each range (`registryConfigSchema.js`).
 *
 * @module features/admin/components/marketplace/registryPins
 */

/** The key of a pin: `<type>:<name>` of a catalog item. */
export const PIN_KEY_PATTERN =
  /^(app|model|prompt|skill|workflow|integration):[A-Za-z0-9._-]{1,100}$/;

/**
 * The pins of a registry as editable rows, in key order.
 *
 * @param {Record<string, string>|undefined} pins
 * @returns {Array<{ key: string, range: string }>}
 */
export function pinsToRows(pins) {
  return Object.entries(pins || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, range]) => ({ key, range }));
}

/**
 * The pin rows as the registry config stores them; empty rows are dropped.
 *
 * @param {Array<{ key: string, range: string }>} rows
 * @returns {Record<string, string>}
 */
export function rowsToPins(rows) {
  const pins = {};
  for (const row of rows) {
    const key = row.key.trim();
    const range = row.range.trim();
    if (key || range) pins[key] = range;
  }
  return pins;
}
