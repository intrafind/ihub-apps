// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';

/** Most matching users listed in the picker; the search narrows the rest. */
const MAX_CANDIDATES = 50;

const displayName = user => user.name || user.username || user.id;

const matches = (user, term) =>
  [user.name, user.username, user.email, user.id].some(value =>
    String(value || '')
      .toLowerCase()
      .includes(term)
  );

function UserLine({ user }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {displayName(user)}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
        @{user.username}
        {user.email ? ` · ${user.email}` : ''}
      </div>
    </div>
  );
}

/**
 * Members of one group: who belongs to it, and a picker to add more users.
 *
 * Changes are applied at once, not with the group's Save button: a member list is
 * edited from the group's side here and from the user's side on the user page, and
 * both write the same `internalGroups` of the user.
 *
 * @param {Object} props
 * @param {string} props.groupId - An existing group
 * @param {boolean} [props.hasExternalMappings] - The group maps external provider groups,
 *   whose users are not listed here
 */
function GroupMembersSection({ groupId, hasExternalMappings = false }) {
  const { t } = useTranslation();
  const searchId = useId();
  const searchRef = useRef(null);
  const [members, setMembers] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  // `showLoading: false` refreshes in place after an add or remove, so the list, the search
  // box and the buttons stay mounted and keyboard focus is not lost.
  const load = useCallback(
    async ({ showLoading = true } = {}) => {
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const [membersResponse, usersResponse] = await Promise.all([
          makeAdminApiCall(`/admin/groups/${encodeURIComponent(groupId)}/members`),
          makeAdminApiCall('/admin/auth/users')
        ]);
        setMembers(membersResponse.data?.items || []);
        setUsers(Object.values(usersResponse.data?.users || {}));
      } catch (error) {
        setLoadError(
          apiErrorMessage(
            error,
            t,
            t('admin.groups.members.loadError', 'The members could not be loaded.')
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [groupId, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const memberIds = useMemo(() => new Set(members.map(member => member.id)), [members]);

  const candidates = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users
      .filter(user => !memberIds.has(user.id) && (!term || matches(user, term)))
      .sort((a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
      );
  }, [users, memberIds, query]);

  const toggle = userId =>
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const runAction = async (action, fallback) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(apiErrorMessage(error, t, getAdminApiErrorMessage(error) || fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addSelected = async () => {
    const userIds = [...selected];
    if (userIds.length === 0) return;
    const ok = await runAction(
      () =>
        makeAdminApiCall(`/admin/groups/${encodeURIComponent(groupId)}/members`, {
          method: 'POST',
          body: { userIds }
        }),
      t('admin.groups.members.addError', 'The users could not be added.')
    );
    if (ok) {
      setSelected(new Set());
      setQuery('');
      await load({ showLoading: false });
      searchRef.current?.focus();
    }
  };

  const removeMember = async member => {
    const ok = await runAction(
      () =>
        makeAdminApiCall(
          `/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(member.id)}`,
          { method: 'DELETE' }
        ),
      t('admin.groups.members.removeError', 'The user could not be removed.')
    );
    if (ok) {
      await load({ showLoading: false });
      // The removed row's button is gone: keep the keyboard where the admin works.
      searchRef.current?.focus();
    }
  };

  return (
    <section
      className="bg-white dark:bg-gray-800 shadow-xs rounded-lg border border-gray-200 dark:border-gray-700"
      aria-labelledby={`${searchId}-title`}
      data-testid="group-members"
    >
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2
          id={`${searchId}-title`}
          className="text-lg font-medium text-gray-900 dark:text-gray-100"
        >
          {t('admin.groups.members.title', 'Members')}
          {!loading && !loadError && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
              ({members.length})
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.groups.members.description',
            'Users that belong to this group. Adding or removing a user takes effect immediately; you do not need to save the group.'
          )}
        </p>
        {hasExternalMappings && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.groups.members.externalNote',
              'Users who get this group from an external provider through the mappings are not listed here.'
            )}
          </p>
        )}
      </div>

      <div className="px-6 py-4 space-y-6">
        {loadError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300"
          >
            {loadError}{' '}
            <button type="button" onClick={() => void load()} className="underline font-medium">
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300"
          >
            {actionError}
          </div>
        )}

        {loading && !loadError && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.groups.members.loading', 'Loading members…')}
          </p>
        )}

        {!loading && !loadError && (
          <>
            {/* Current members */}
            {members.length === 0 ? (
              <p
                className="text-sm text-gray-500 dark:text-gray-400"
                data-testid="group-members-empty"
              >
                {t('admin.groups.members.empty', 'This group has no members yet.')}
              </p>
            ) : (
              <ul
                className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md"
                data-testid="group-members-list"
              >
                {members.map(member => (
                  <li key={member.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <UserLine user={member} />
                      {!member.active && (
                        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                          {t('admin.groups.members.inactive', 'Inactive')}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeMember(member)}
                      aria-label={t('admin.groups.members.remove', 'Remove {{name}} from group', {
                        name: displayName(member)
                      })}
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md disabled:opacity-50 focus:outline-hidden focus:ring-2 focus:ring-red-500"
                    >
                      <Icon name="x" size="sm" />
                      {t('admin.groups.members.removeShort', 'Remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Add users */}
            <div>
              <label
                htmlFor={searchId}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.groups.members.addLabel', 'Add users')}
              </label>
              <div className="mt-1">
                <input
                  id={searchId}
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => {
                    // The panel sits inside the group form: Enter here must not save it.
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  placeholder={t(
                    'admin.groups.members.searchPlaceholder',
                    'Search by name, username or email'
                  )}
                  className={INPUT_CLASS}
                />
              </div>

              {candidates.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {query.trim()
                    ? t('admin.groups.members.noMatches', 'No users match your search.')
                    : t('admin.groups.members.allAdded', 'Every user is already a member.')}
                </p>
              ) : (
                <ul
                  className="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md"
                  data-testid="group-members-candidates"
                >
                  {candidates.slice(0, MAX_CANDIDATES).map(user => {
                    const checkboxId = `${searchId}-${user.id}`;
                    return (
                      <li key={user.id}>
                        <label
                          htmlFor={checkboxId}
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={selected.has(user.id)}
                            onChange={() => toggle(user.id)}
                            className={CHECKBOX_CLASS}
                          />
                          <UserLine user={user} />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {candidates.length > MAX_CANDIDATES && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.members.moreMatches',
                    '{{count}} more users match. Narrow the search to find them.',
                    { count: candidates.length - MAX_CANDIDATES }
                  )}
                </p>
              )}

              <div className="mt-3">
                <button
                  type="button"
                  disabled={busy || selected.size === 0}
                  onClick={() => void addSelected()}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" size="sm" className="mr-2" />
                  {t('admin.groups.members.addSelected', 'Add {{count}} selected', {
                    count: selected.size
                  })}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default GroupMembersSection;
