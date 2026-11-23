// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/** Whether an entry of the apps list is a personal app. */
export const isUserApp = app => app?.ownership === 'user';

/**
 * Whether the app is offered to the caller. A person the app is already shared
 * with keeps that role ("Can use", "Can edit") while the offer is open, so the
 * role alone does not say it; `canAcceptOffer` does.
 *
 * @param {Object} app - A personal app as the server answers it.
 * @returns {boolean}
 */
const isOfferedToCaller = app =>
  app?.permissions?.role === 'offered' || app?.permissions?.canAcceptOffer === true;

/**
 * Which scope chip of the apps page a personal app belongs to.
 *
 * @param {Object} app - An entry of the apps list.
 * @returns {'mine'|'shared'|null} `mine`: the caller owns it, or it is offered
 *   to them. `shared`: someone else's. null: not a personal app.
 */
export function userAppScope(app) {
  if (!isUserApp(app)) return null;
  const permissions = app.permissions || {};
  return permissions.isOwner === true || isOfferedToCaller(app) ? 'mine' : 'shared';
}

/**
 * The line a personal tile carries: whose app it is and, for the owner, the
 * state it is in. The server decides all of it (`permissions`, `state`,
 * `disabled`, `pendingOwner`, `owner`); this only picks the words.
 *
 * @param {Object} app - A personal app of the list.
 * @param {(key: string, values?: Object) => string} t
 * @returns {string} "Mine", "Offered to you", "Offered to Ben Koch", "Now with
 *   the administrators", "Switched off by an administrator", or the owner's name.
 */
export function userAppBadgeText(app, t) {
  const permissions = app?.permissions || {};
  if (isOfferedToCaller(app)) return t('userApps.list.badge.offered');
  if (permissions.isOwner === true) {
    if (app.disabled) return t('userApps.edit.state.disabled');
    if (app.state === 'promoted' || app.state === 'retired') {
      return t('userApps.edit.state.promoted');
    }
    if (app.pendingOwner?.name) {
      return t('userApps.edit.state.offered', { owner: app.pendingOwner.name });
    }
    return t('userApps.list.badge.mine');
  }
  return app?.owner?.name || app?.owner?.id || '';
}

/**
 * The bottom line of a personal app's tile. Text with a dot in front; the
 * state is never told by colour alone. Renders nothing for an admin app.
 *
 * @param {Object} props
 * @param {Object} props.app - An entry of the apps list.
 * @returns {JSX.Element|null}
 */
function UserAppBadge({ app }) {
  const { t } = useTranslation();
  if (!isUserApp(app)) return null;
  const text = userAppBadgeText(app, t);
  if (!text) return null;
  return (
    <span
      data-testid="user-app-badge"
      className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full bg-indigo-500 dark:bg-indigo-400"
      />
      <span className="truncate">{text}</span>
    </span>
  );
}

export default UserAppBadge;
