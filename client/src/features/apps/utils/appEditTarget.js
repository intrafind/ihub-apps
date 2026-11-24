// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where the "Edit app" button of a chat leads for this viewer, or null when it
 * should not be shown.
 *
 * - A personal app (`ownership: 'user'`) is edited in the personal editor
 *   (`/apps/{id}/edit`), by whoever the server says may edit it
 *   (`permissions.canEdit`: its owner, or a person it is shared with as
 *   "Can edit"). The admin editor does not know personal apps.
 * - Any other app is edited in the admin editor (`/admin/apps/{id}`), by admins.
 *
 * @param {Object|null|undefined} app - The app as `GET /api/apps/{appId}` answers it.
 * @param {Object|null|undefined} user - The signed-in user.
 * @param {string|undefined} appId - The ID of the open app.
 * @returns {string|null} The path to navigate to.
 *
 * @example
 * appEditPath({ ownership: 'user', permissions: { canEdit: true } }, user, 'uap_1');
 * // → '/apps/uap_1/edit'
 */
export function appEditPath(app, user, appId) {
  if (!appId) return null;
  const id = encodeURIComponent(appId);
  if (app?.ownership === 'user') {
    return app.permissions?.canEdit === true ? `/apps/${id}/edit` : null;
  }
  return user?.isAdmin ? `/admin/apps/${id}` : null;
}
