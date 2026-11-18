// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { normalizeUsageLimits } from '../components/UsageLimitsEditor';

/**
 * The body the user editor sends to `POST /api/admin/auth/users` (create) or
 * `PUT /api/admin/auth/users/:id` (update).
 *
 * `active` is the stored field (users.json has no `enabled`). On an update it
 * is sent only when the admin changed it, so saving an unrelated edit (an
 * email) never re-enables a deactivated account, and never runs into the
 * server's refusal to deactivate your own account. A create always sends it,
 * and so does an update after a failed one that sent it (`forceActive`): that
 * write may have been stored, so the loaded value is no longer a safe baseline.
 *
 * @param {Object} data - The edited user
 * @param {Object} options
 * @param {boolean} options.isNew - Creating rather than updating
 * @param {Object|null} [options.initial] - The user as loaded (updates only)
 * @param {boolean} [options.forceActive=false] - Send `active` even when it
 *   matches `initial` (the last save that sent it had an unknown outcome)
 * @returns {Object} The request body
 *
 * @example
 * buildUserSavePayload({ ...loaded, email: 'x@y' }, { isNew: false, initial: loaded });
 * // → no `active` key: the account keeps its state
 */
export function buildUserSavePayload(data, { isNew, initial = null, forceActive = false }) {
  const body = {
    username: data.username,
    email: data.email || null,
    name: data.fullName || data.name || '',
    // Use internalGroups, with fallback to groups for backward compatibility
    internalGroups: data.internalGroups || data.groups || [],
    authMethods: data.authMethods || ['local']
  };

  const active = data.active !== false;
  if (isNew || forceActive || active !== (initial?.active !== false)) {
    body.active = active;
  }

  // Personal usage limits (only the update route accepts them); `null`
  // clears limits saved before.
  if (!isNew) {
    body.usageLimits = normalizeUsageLimits(data.usageLimits);
  }

  // Only include password if it's provided
  if (data.password) {
    body.password = data.password;
  }
  return body;
}
