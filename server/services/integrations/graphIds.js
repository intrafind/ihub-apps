// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Microsoft Graph identifiers (drive, item and folder ids) as they may be
 * interpolated into a Graph URL path: one path segment of safe characters,
 * so an id can never add a segment (`<id>/content`), a query or a fragment.
 * Shared by the Office 365 routes, the service and the project kind.
 *
 * @module services/integrations/graphIds
 */

/** The longest Graph id accepted. */
export const MAX_GRAPH_ID_LENGTH = 512;

/**
 * Whether `id` is a safe Graph identifier.
 *
 * `!` is part of real Graph ids: business drive ids look like `b!Xk3…`,
 * consumer item ids like `ABC123!105`. It is a valid path character.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidGraphId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > MAX_GRAPH_ID_LENGTH) return false;
  return /^[A-Za-z0-9._!-]+$/.test(trimmed);
}

export default isValidGraphId;
