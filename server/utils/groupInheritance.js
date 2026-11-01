// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../configCache.js';

/**
 * A user's groups plus every group they inherit (`inherits` in groups.json),
 * so a resource open to `users` is open to `admins`, who inherit it. Group
 * membership on a user is the direct list; permissions are resolved through
 * inheritance when the user is enhanced, and access lists that name groups
 * (an installation's `allowedGroups`, a directory's `groups`) are read the
 * same way here.
 *
 * @param {string[]} groups - The user's direct groups
 * @returns {Set<string>}
 */
export function expandUserGroups(groups) {
  const config = configCache.getGroups?.()?.data?.groups || {};
  const result = new Set();
  const queue = Array.isArray(groups) ? [...groups] : [];
  while (queue.length > 0) {
    const group = queue.shift();
    if (typeof group !== 'string' || result.has(group)) continue;
    result.add(group);
    for (const parent of config[group]?.inherits || []) queue.push(parent);
  }
  return result;
}

/**
 * Whether a user is in one of the allowed groups, inherited groups included.
 * `*` admits every caller; an empty list admits nobody.
 *
 * @param {object|null} user - `{ groups }`
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function userInGroups(user, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  if (allowed.includes('*')) return true;
  if (!user) return false;
  const groups = expandUserGroups(user.groups);
  return allowed.some(group => groups.has(group));
}
