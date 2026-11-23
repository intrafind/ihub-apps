// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Switch from '../../../shared/components/Switch';
import { useFilterState } from '../hooks/useFilterState';
import {
  acknowledgementStatus,
  latestAcknowledgement,
  useAiAcknowledgementAdmin
} from '../hooks/useAiAcknowledgementAdmin';
import {
  AiAcknowledgementActions,
  AiAcknowledgementCell
} from '../components/AiAcknowledgementActions';
import {
  DataTable,
  SearchInput,
  FilterSelect,
  parseSortParam,
  formatSortParam
} from '../components/data-table';
import EuAiActStateNote from '../components/euAiAct/EuAiActStateNote';

function UserNameCell({ user }) {
  return (
    <div className="flex items-center">
      <div className="shrink-0 h-10 w-10">
        <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
          <Icon name="user" size="md" className="text-gray-600 dark:text-gray-300" />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {user.name || user.username}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">@{user.username}</div>
      </div>
    </div>
  );
}

function AuthMethodCell({ user }) {
  const { t } = useTranslation();
  const methods = user.authMethods || ['local'];
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-1">
        {methods.map((method, index) => (
          <span
            key={index}
            className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
              method === 'local'
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
                : method === 'oidc'
                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300'
                  : 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300'
            }`}
          >
            <Icon
              name={method === 'local' ? 'key' : method === 'oidc' ? 'globe' : 'shield-check'}
              size="xs"
              className="mr-1"
            />
            {method.toUpperCase()}
          </span>
        ))}
      </div>
      {user.oidcData && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {user.oidcData.provider}
        </div>
      )}
      {user.proxyData && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('admin.overview.auth.proxy', 'Proxy')}
        </div>
      )}
    </div>
  );
}

function GroupsCell({ user }) {
  const { t } = useTranslation();
  const groups = user.internalGroups || [];
  if (groups.length === 0) {
    return (
      <span className="text-sm text-gray-500 dark:text-gray-400">
        {t('admin.users.list.noGroups', 'No groups')}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((group, index) => (
        <span
          key={index}
          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
        >
          {group}
        </span>
      ))}
    </div>
  );
}

function StatusCell({ user, onToggle }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center space-x-3">
      <span
        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
          user.active !== false
            ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
            : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
        }`}
      >
        {user.active !== false
          ? t('admin.users.view.active', 'Active')
          : t('admin.users.view.inactive', 'Inactive')}
      </span>
      <Switch
        size="sm"
        checked={user.active !== false}
        onChange={(_next, event) => {
          // The row must not react to the toggle.
          event.stopPropagation();
          onToggle(user);
        }}
        aria-label={t('admin.users.statusToggle', 'Account active: {{name}}', {
          name: user.name || user.username
        })}
      />
    </div>
  );
}

function LastActiveCell({ user }) {
  const { t } = useTranslation();
  // Captured once per mount — the static "days ago" label needs no live clock
  const [now] = useState(() => Date.now());
  if (!user.lastActiveDate) {
    return (
      <span className="text-gray-500 dark:text-gray-400">
        {t('admin.users.list.never', 'Never')}
      </span>
    );
  }
  const daysAgo = Math.floor((now - new Date(user.lastActiveDate)) / (1000 * 60 * 60 * 24));
  return (
    <div className="flex flex-col">
      <span>{new Date(user.lastActiveDate).toLocaleDateString()}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('admin.users.list.daysAgo', '{{count}} days ago', { count: daysAgo })}
      </span>
    </div>
  );
}

function AdminUsersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [authMethodFilter, setAuthMethodFilter] = useFilterState('auth', 'all');
  const [groupFilter, setGroupFilter] = useFilterState('group', 'all');
  const [statusFilter, setStatusFilter] = useFilterState('status', 'all');
  const [lastActiveDaysFilter, setLastActiveDaysFilter] = useFilterState('days', 'all');
  const [ackFilter, setAckFilter] = useFilterState('ack', 'all');
  const [sortParam, setSortParam] = useFilterState('sort', '');
  const sort = useMemo(
    () => parseSortParam(sortParam) || { column: 'name', direction: 'asc' },
    [sortParam]
  );

  useEffect(() => {
    void loadUsers();
  }, []);

  // AI-use acknowledgements (#3326): the same hook the EU AI Act page will use.
  const ack = useAiAcknowledgementAdmin({ onChanged: () => void loadUsers() });
  const ackRequired = ack.settings?.requiredVersion ?? 1;
  const ackResetAt = ack.settings?.resetAt ?? null;
  const ackEnabled = ack.settings?.enabled === true;

  const loadUsers = async () => {
    try {
      const response = await makeAdminApiCall('/admin/auth/users');
      const data = response.data;
      const usersArray = Object.values(data.users || {});
      setUsers(usersArray);
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('admin.users.list.loadError', 'Failed to load users: {{error}}', {
          error: error.message
        })
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = userId => {
    setConfirmDialog({
      title: t('admin.users.deleteTitle', 'Delete User'),
      message: t(
        'admin.users.deleteConfirm',
        'Delete this user? Their access ends immediately, and their API keys, connections, stored credentials, scheduled tasks, chats, prompts, skills and short links are removed. This cannot be undone. To stop someone from signing in and keep what they made, disable the account instead.'
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/admin/auth/users/${userId}`, { method: 'DELETE' });
          setMessage({ type: 'success', text: t('admin.users.list.deleted', 'User deleted.') });
          void loadUsers();
        } catch (error) {
          // A refusal (your own account, the last admin) says why, from its code.
          setMessage({
            type: 'error',
            text: t('admin.users.list.deleteError', 'Failed to delete user: {{error}}', {
              error: apiErrorMessage(error, t, getAdminApiErrorMessage(error))
            })
          });
        }
      }
    });
  };

  const handleToggleUserStatus = async user => {
    // A record without `active` is active (the switch shows it on).
    const newStatus = user.active === false;
    try {
      await makeAdminApiCall(`/admin/auth/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: {
          email: user.email,
          name: user.name,
          internalGroups: user.internalGroups || [],
          active: newStatus
        }
      });
      setMessage({
        type: 'success',
        text: newStatus
          ? t('admin.users.list.enabled', 'User enabled.')
          : t('admin.users.list.disabled', 'User disabled.')
      });
      void loadUsers();
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('admin.users.list.statusError', 'Failed to update user status: {{error}}', {
          error: apiErrorMessage(error, t, getAdminApiErrorMessage(error))
        })
      });
    }
  };

  const filteredUsers = users.filter(user => {
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      const id = (user.id || '').toLowerCase();
      const name = (user.name || '').toLowerCase();
      const username = (user.username || '').toLowerCase();
      const email = (user.email || '').toLowerCase();
      const groups = (user.internalGroups || []).join(' ').toLowerCase();
      const authMethods = (user.authMethods || ['local']).join(' ').toLowerCase();
      if (!(
        id.includes(searchLower) ||
        name.includes(searchLower) ||
        username.includes(searchLower) ||
        email.includes(searchLower) ||
        groups.includes(searchLower) ||
        authMethods.includes(searchLower)
      )) {
        return false;
      }
    }
    if (authMethodFilter !== 'all') {
      const userAuthMethods = user.authMethods || ['local'];
      if (!userAuthMethods.includes(authMethodFilter)) return false;
    }
    if (groupFilter !== 'all') {
      const userGroups = user.internalGroups || [];
      if (!userGroups.includes(groupFilter)) return false;
    }
    if (statusFilter !== 'all') {
      const isActive = user.active !== false;
      if ((statusFilter === 'active' && !isActive) || (statusFilter === 'inactive' && isActive)) {
        return false;
      }
    }
    if (ackEnabled && ackFilter !== 'all') {
      if (acknowledgementStatus(user, ackRequired, ackResetAt) !== ackFilter) return false;
    }
    if (lastActiveDaysFilter !== 'all') {
      if (!user.lastActiveDate) return lastActiveDaysFilter === 'never';
      const daysAgo = Math.floor(
        (Date.now() - new Date(user.lastActiveDate)) / (1000 * 60 * 60 * 24)
      );
      if (lastActiveDaysFilter === '7' && daysAgo > 7) return false;
      if (lastActiveDaysFilter === '30' && daysAgo > 30) return false;
      if (lastActiveDaysFilter === '90' && daysAgo > 90) return false;
      if (lastActiveDaysFilter === 'never' && user.lastActiveDate) return false;
    }
    return true;
  });

  const allGroups = useMemo(
    () => [...new Set(users.flatMap(u => u.internalGroups || []))],
    [users]
  );

  const columns = [
    {
      key: 'name',
      header: t('admin.users.list.colUser', 'User'),
      sortable: true,
      sortAccessor: u => (u.name || u.username || '').toLowerCase(),
      render: u => <UserNameCell user={u} />
    },
    {
      key: 'authMethods',
      header: t('admin.users.list.colAuthMethod', 'Auth Method'),
      hideBelow: 'md',
      render: u => <AuthMethodCell user={u} />
    },
    {
      key: 'groups',
      header: t('admin.users.groups', 'Groups'),
      hideBelow: 'lg',
      render: u => <GroupsCell user={u} />
    },
    {
      key: 'status',
      header: t('common.status', 'Status'),
      sortable: true,
      sortAccessor: u => (u.active !== false ? 1 : 0),
      render: u => <StatusCell user={u} onToggle={handleToggleUserStatus} />
    },
    {
      key: 'lastActive',
      header: t('admin.users.list.colLastActive', 'Last Active'),
      sortable: true,
      hideBelow: 'lg',
      sortAccessor: u => (u.lastActiveDate ? new Date(u.lastActiveDate).getTime() : 0),
      render: u => <LastActiveCell user={u} />
    },
    ...(ackEnabled
      ? [
          {
            key: 'aiAck',
            header: t('admin.users.aiAcknowledgement.column', 'AI acknowledgement'),
            hideBelow: 'md',
            sortable: true,
            sortAccessor: u => {
              const entry = latestAcknowledgement(u);
              return entry?.acknowledgedAt ? new Date(entry.acknowledgedAt).getTime() : 0;
            },
            render: u => (
              <AiAcknowledgementCell
                user={u}
                status={acknowledgementStatus(u, ackRequired, ackResetAt)}
                requiredVersion={ackRequired}
              />
            )
          }
        ]
      : [])
  ];

  const actions = [
    {
      id: 'view',
      label: t('admin.users.list.viewUser', 'View user'),
      icon: 'eye',
      onClick: u => navigate(`/admin/users/${u.id}/view`)
    },
    {
      id: 'edit',
      label: t('admin.users.list.editUser', 'Edit user'),
      icon: 'edit',
      priority: 'primary',
      onClick: u => navigate(`/admin/users/${u.id}`)
    },
    {
      id: 'delete',
      label: t('admin.users.list.deleteUser', 'Delete user'),
      icon: 'trash',
      destructive: true,
      onClick: u => handleDeleteUser(u.id)
    },
    ...(ackEnabled
      ? [
          {
            id: 'removeAck',
            label: t('admin.users.aiAcknowledgement.removeRow', 'Remove AI acknowledgement'),
            icon: 'trash',
            destructive: true,
            hidden: u => !(u.aiAcknowledgements?.length > 0) || ack.settings?.masterOn === false,
            onClick: u => ack.askRemoveOne(u)
          }
        ]
      : [])
  ];

  // What "Remove all" deletes, and the filter the CSV honours.
  const confirmedCount = users.reduce((sum, u) => sum + (u.aiAcknowledgements?.length || 0), 0);
  const exportStatus =
    ackFilter === 'acknowledged' ? 'acknowledged' : ackFilter === 'all' ? undefined : 'pending';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.users.list.title', 'User Management')}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.users.list.subtitle',
                  'Manage local authentication users and their permissions'
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <AiAcknowledgementActions
                admin={ack}
                confirmedCount={confirmedCount}
                exportStatus={exportStatus}
              />
              <button
                onClick={() => navigate('/admin/users/new')}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Icon name="plus" size="md" className="mr-2" />
                {t('admin.users.list.addUser', 'Add User')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <EuAiActStateNote
          hideWhenOn
          className="mb-4"
          offText={t(
            'admin.euAiAct.master.usersOff',
            'AI acknowledgement is not asked while EU AI Act features are switched off. Values shown are from before.'
          )}
        />
        {/* The page's own result and the AI acknowledgement actions' result: both are shown,
            so a newer one is never hidden behind an older one. */}
        {[message, ack.message].filter(Boolean).map((banner, index) => (
          <div
            key={`${index}-${banner.text}`}
            role="status"
            className={`mb-6 p-4 rounded-md ${
              banner.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
            }`}
          >
            <div className="flex">
              <Icon
                name={banner.type === 'success' ? 'check' : 'warning'}
                size="md"
                className={`mt-0.5 mr-3 ${
                  banner.type === 'success' ? 'text-green-500' : 'text-red-700'
                }`}
              />
              <p
                className={`text-sm ${
                  banner.type === 'success'
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {banner.text}
              </p>
            </div>
          </div>
        ))}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={t(
              'admin.users.list.searchPlaceholder',
              'Search by ID, name, email, group, or auth method…'
            )}
          />
        </div>

        <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-4">
          {/* Each filter takes the width its label and options need and the row wraps: fixed grid
              columns pushed the last filter past the card when labels or options are long. */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <FilterSelect
              label={t('admin.users.list.colAuthMethod', 'Auth Method')}
              value={authMethodFilter}
              onChange={setAuthMethodFilter}
              options={[
                { value: 'all', label: t('admin.users.list.allMethods', 'All Methods') },
                { value: 'local', label: t('admin.overview.auth.local', 'Local') },
                { value: 'oidc', label: 'OIDC' },
                { value: 'proxy', label: t('admin.overview.auth.proxy', 'Proxy') }
              ]}
            />
            <FilterSelect
              label={t('admin.groups.fields.group', 'Group')}
              value={groupFilter}
              onChange={setGroupFilter}
              options={[
                { value: 'all', label: t('admin.users.list.allGroups', 'All Groups') },
                ...allGroups.map(g => ({ value: g, label: g }))
              ]}
            />
            <FilterSelect
              label={t('common.status', 'Status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: t('admin.users.list.allStatus', 'All Statuses') },
                { value: 'active', label: t('admin.users.view.active', 'Active') },
                { value: 'inactive', label: t('admin.users.view.inactive', 'Inactive') }
              ]}
            />
            <FilterSelect
              label={t('admin.users.list.colLastActive', 'Last Active')}
              value={lastActiveDaysFilter}
              onChange={setLastActiveDaysFilter}
              options={[
                { value: 'all', label: t('admin.users.list.anyTime', 'Any Time') },
                { value: '7', label: t('admin.users.list.last7', 'Last 7 days') },
                { value: '30', label: t('admin.users.list.last30', 'Last 30 days') },
                { value: '90', label: t('admin.users.list.last90', 'Last 90 days') },
                { value: 'never', label: t('admin.users.list.never', 'Never') }
              ]}
            />
            {ackEnabled && (
              <FilterSelect
                label={t('admin.users.aiAcknowledgement.filter', 'AI acknowledgement')}
                value={ackFilter}
                onChange={setAckFilter}
                options={[
                  { value: 'all', label: t('admin.users.aiAcknowledgement.filterAll', 'All') },
                  {
                    value: 'acknowledged',
                    label: t('admin.users.aiAcknowledgement.filterAcknowledged', 'Acknowledged')
                  },
                  {
                    value: 'outdated',
                    label: t('admin.users.aiAcknowledgement.filterOutdated', 'Outdated')
                  },
                  {
                    value: 'never',
                    label: t('admin.users.aiAcknowledgement.filterNever', 'Not acknowledged')
                  }
                ]}
              />
            )}
          </div>
          {ackEnabled && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.users.aiAcknowledgement.anonymousNote',
                'Confirmations of anonymous sessions appear only in the audit log.'
              )}
            </p>
          )}
        </div>

        <DataTable
          columns={columns}
          data={filteredUsers}
          getRowId={u => u.id}
          actions={actions}
          loading={loading}
          sort={sort}
          onSortChange={next => setSortParam(formatSortParam(next))}
          empty={{
            icon: 'users',
            title: searchTerm ? `No users found matching "${searchTerm}"` : 'No users found',
            description: searchTerm
              ? 'Try adjusting your search criteria'
              : 'Create your first user to get started'
          }}
        />
      </div>
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminUsersPage;
