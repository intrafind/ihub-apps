import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useFilterState } from '../hooks/useFilterState';
import {
  DataTable,
  SearchInput,
  FilterSelect,
  parseSortParam,
  formatSortParam
} from '../components/data-table';

function UserNameCell({ user }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-10 w-10">
        <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
          <Icon name="user" size="md" className="text-gray-600 dark:text-gray-300" />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {user.name || user.username}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
        <div className="text-xs text-gray-400 dark:text-gray-500 truncate">@{user.username}</div>
      </div>
    </div>
  );
}

function AuthMethodCell({ user }) {
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
      {user.proxyData && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Proxy</div>}
    </div>
  );
}

function GroupsCell({ user }) {
  const groups = user.internalGroups || [];
  if (groups.length === 0) {
    return <span className="text-sm text-gray-400 dark:text-gray-500">No groups</span>;
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
  return (
    <div className="flex items-center space-x-3">
      <span
        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
          user.active !== false
            ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
            : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
        }`}
      >
        {user.active !== false ? 'Active' : 'Inactive'}
      </span>
      <label
        className="relative inline-flex items-center cursor-pointer"
        onClick={e => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={user.active !== false}
          onChange={() => onToggle(user)}
          className="sr-only peer"
        />
        <div className="w-9 h-5 bg-gray-200 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
      </label>
    </div>
  );
}

function LastActiveCell({ user }) {
  if (!user.lastActiveDate) {
    return <span className="text-gray-400 dark:text-gray-500">Never</span>;
  }
  const daysAgo = Math.floor((Date.now() - new Date(user.lastActiveDate)) / (1000 * 60 * 60 * 24));
  return (
    <div className="flex flex-col">
      <span>{new Date(user.lastActiveDate).toLocaleDateString()}</span>
      <span className="text-xs text-gray-400 dark:text-gray-500">{daysAgo} days ago</span>
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
  const [sortParam, setSortParam] = useFilterState('sort', '');
  const sort = useMemo(
    () => parseSortParam(sortParam) || { column: 'name', direction: 'asc' },
    [sortParam]
  );

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const response = await makeAdminApiCall('/admin/auth/users');
      const data = response.data;
      const usersArray = Object.values(data.users || {});
      setUsers(usersArray);
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to load users: ${error.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = userId => {
    setConfirmDialog({
      title: t('admin.users.deleteTitle', 'Delete User'),
      message: t('admin.users.deleteConfirm', 'Are you sure you want to delete this user?'),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/admin/auth/users/${userId}`, { method: 'DELETE' });
          setMessage({ type: 'success', text: 'User deleted successfully!' });
          loadUsers();
        } catch (error) {
          setMessage({ type: 'error', text: `Failed to delete user: ${error.message}` });
        }
      }
    });
  };

  const handleToggleUserStatus = async user => {
    const newStatus = !user.active;
    try {
      await makeAdminApiCall(`/admin/auth/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
          internalGroups: user.internalGroups || [],
          active: newStatus
        })
      });
      setMessage({
        type: 'success',
        text: `User ${newStatus ? 'enabled' : 'disabled'} successfully!`
      });
      loadUsers();
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to update user status: ${error.message}` });
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
      header: 'User',
      sortable: true,
      sortAccessor: u => (u.name || u.username || '').toLowerCase(),
      render: u => <UserNameCell user={u} />
    },
    {
      key: 'authMethods',
      header: 'Auth Method',
      hideBelow: 'md',
      render: u => <AuthMethodCell user={u} />
    },
    {
      key: 'groups',
      header: 'Groups',
      hideBelow: 'lg',
      render: u => <GroupsCell user={u} />
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortAccessor: u => (u.active !== false ? 1 : 0),
      render: u => <StatusCell user={u} onToggle={handleToggleUserStatus} />
    },
    {
      key: 'lastActive',
      header: 'Last Active',
      sortable: true,
      hideBelow: 'lg',
      sortAccessor: u => (u.lastActiveDate ? new Date(u.lastActiveDate).getTime() : 0),
      render: u => <LastActiveCell user={u} />
    }
  ];

  const actions = [
    {
      id: 'view',
      label: 'View user',
      icon: 'eye',
      onClick: u => navigate(`/admin/users/${u.id}/view`)
    },
    {
      id: 'edit',
      label: 'Edit user',
      icon: 'edit',
      priority: 'primary',
      onClick: u => navigate(`/admin/users/${u.id}`)
    },
    {
      id: 'delete',
      label: 'Delete user',
      icon: 'trash',
      destructive: true,
      onClick: u => handleDeleteUser(u.id)
    }
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                User Management
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                Manage local authentication users and their permissions
              </p>
            </div>
            <button
              onClick={() => navigate('/admin/users/new')}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              <Icon name="plus" size="md" className="mr-2" />
              Add User
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {message && (
          <div
            className={`mb-6 p-4 rounded-md ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
            }`}
          >
            <div className="flex">
              <Icon
                name={message.type === 'success' ? 'check' : 'warning'}
                size="md"
                className={`mt-0.5 mr-3 ${
                  message.type === 'success' ? 'text-green-500' : 'text-red-500'
                }`}
              />
              <p
                className={`text-sm ${
                  message.type === 'success'
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {message.text}
              </p>
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search by ID, name, email, group, or auth method…"
          />
        </div>

        <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <FilterSelect
              label="Auth Method"
              value={authMethodFilter}
              onChange={setAuthMethodFilter}
              options={[
                { value: 'all', label: 'All Methods' },
                { value: 'local', label: 'Local' },
                { value: 'oidc', label: 'OIDC' },
                { value: 'proxy', label: 'Proxy' }
              ]}
            />
            <FilterSelect
              label="Group"
              value={groupFilter}
              onChange={setGroupFilter}
              options={[
                { value: 'all', label: 'All Groups' },
                ...allGroups.map(g => ({ value: g, label: g }))
              ]}
            />
            <FilterSelect
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: 'All Status' },
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' }
              ]}
            />
            <FilterSelect
              label="Last Active"
              value={lastActiveDaysFilter}
              onChange={setLastActiveDaysFilter}
              options={[
                { value: 'all', label: 'Any Time' },
                { value: '7', label: 'Last 7 days' },
                { value: '30', label: 'Last 30 days' },
                { value: '90', label: 'Last 90 days' },
                { value: 'never', label: 'Never' }
              ]}
            />
          </div>
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
