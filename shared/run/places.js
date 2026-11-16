// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The places a tool call looked in (#3668): the projects or the search profile
 * of a search or read, by name, with who owns them (`user` or `admin`). The
 * server names them (`places` on `tool/completed`); nothing here works a name
 * out from a tool id or a source. One bound for the stream, the reducer and the
 * stored activity.
 *
 * @module shared/run/places
 */

/** Most places a call reports, and the longest name kept. */
export const MAX_PLACES = 10;
export const MAX_PLACE_NAME = 120;

/**
 * One place as kept: a trimmed, bounded name and a known ownership.
 *
 * @param {unknown} place - `{ name, ownership? }`
 * @returns {{name: string, ownership?: 'user'|'admin'}|null} null without a name
 */
export function normalizePlace(place) {
  const name = typeof place?.name === 'string' ? place.name.trim().slice(0, MAX_PLACE_NAME) : '';
  if (!name) return null;
  return place.ownership === 'user' || place.ownership === 'admin'
    ? { name, ownership: place.ownership }
    : { name };
}

/**
 * A list of places as kept: each normalized, no repeats, at most
 * {@link MAX_PLACES}. Anything that is not a list is none.
 *
 * @param {unknown} places
 * @returns {Array<{name: string, ownership?: 'user'|'admin'}>}
 */
export function normalizePlaces(places) {
  const out = [];
  for (const raw of Array.isArray(places) ? places : []) {
    if (out.length >= MAX_PLACES) break;
    const place = normalizePlace(raw);
    if (!place) continue;
    if (out.some(known => known.name === place.name && known.ownership === place.ownership)) {
      continue;
    }
    out.push(place);
  }
  return out;
}

/**
 * The places a share may carry: the names of what an admin owns. A user's
 * project name is the owner's, and a place without a known owner is not
 * assumed to be an admin's.
 *
 * @param {unknown} places
 * @returns {Array<{name: string, ownership: 'admin'}>}
 */
export function sharablePlaces(places) {
  return normalizePlaces(places).filter(place => place.ownership === 'admin');
}
