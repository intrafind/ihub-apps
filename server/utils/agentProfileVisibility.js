// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether a user may see (and so run) an agent profile. The one policy for
 * the profile routes and for the admin projects a profile links.
 *
 * @param {Object} profile
 * @param {Object|undefined} user
 * @returns {boolean}
 */
export function visibleToUser(profile, user) {
  // Admins see all.
  if (user?.isAdmin) return true;
  // Operators see profiles where they are in profile.groups.
  const allow = profile.groups || [];
  if (allow.length === 0) return true;
  const userGroups = user?.groups || [];
  return allow.some(g => userGroups.includes(g));
}
