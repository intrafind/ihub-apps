import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminUsersPage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [authMethodFilter, setAuthMethodFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [lastActiveDaysFilter, setLastActiveDaysFilter] = useState('all');
  const [sortColumn, setSortColumn] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const response = await makeAdminApiCall('/admin/auth/users');
      const data = response.data;

      // Convert users object to array
      const usersArray = Object.values(data.users || {});
      setUsers(usersArray);
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to load users: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async userId => {
    if (!window.confirm('Are you sure you want to delete this user?')) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/auth/users/${userId}`, {
        method: 'DELETE'
      });

      // Axios returns successful responses directly, errors are thrown
      setMessage({
        type: 'success',
        text: 'User deleted successfully!'
      });
      loadUsers();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to delete user: ${error.message}`
      });
    }
  };

  const handleToggleUserStatus = async user => {
    const newStatus = !user.active;

    try {
      await makeAdminApiCall(`/admin/auth/users/${user.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
          internalGroups: user.internalGroups || [],
          active: newStatus
        })
      });

      // Axios returns successful responses directly, errors are thrown
      setMessage({
        type: 'success',
        text: `User ${newStatus ? 'enabled' : 'disabled'} successfully!`
      });
      loadUsers();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to update user status: ${error.message}`
      });
    }
  };

  const clearSearch = () => {
    setSearchTerm('');
  };

  const handleSort = column => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Filter users based on search term and filters
  const filteredUsers = users.filter(user => {
    // Search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      const id = (user.id || '').toLowerCase();
      const name = (user.name || '').toLowerCase();
      const username = (user.username || '').toLowerCase();
      const email = (user.email || '').toLowerCase();
      const groups = (user.internalGroups || []).join(' ').toLowerCase();
      const authMethods = (user.authMethods || ['local']).join(' ').toLowerCase();

      if (
        !(
          id.includes(searchLower) ||
          name.includes(searchLower) ||
          username.includes(searchLower) ||
          email.includes(searchLower) ||
          groups.includes(searchLower) ||
          authMethods.includes(searchLower)
        )
      ) {
        return false;
      }
    }

    // Auth method filter
    if (authMethodFilter !== 'all') {
      const userAuthMethods = user.authMethods || ['local'];
      if (!userAuthMethods.includes(authMethodFilter)) {
        return false;
      }
    }

    // Group filter
    if (groupFilter !== 'all') {
      const userGroups = user.internalGroups || [];
      if (!userGroups.includes(groupFilter)) {
        return false;
      }
    }

    // Status filter
    if (statusFilter !== 'all') {
      const isActive = user.active !== false;
      if ((statusFilter === 'active' && !isActive) || (statusFilter === 'inactive' && isActive)) {
        return false;
      }
    }

    // Last active days filter
    if (lastActiveDaysFilter !== 'all') {
      if (!user.lastActiveDate) {
        return lastActiveDaysFilter === 'never';
      }

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

  // Sort users
  const sortedUsers = [...filteredUsers].sort((a, b) => {
    let compareValue = 0;

    if (sortColumn === 'name') {
      const nameA = (a.name || a.username || '').toLowerCase();
      const nameB = (b.name || b.username || '').toLowerCase();
      compareValue = nameA.localeCompare(nameB);
    } else if (sortColumn === 'lastActive') {
      const dateA = a.lastActiveDate ? new Date(a.lastActiveDate).getTime() : 0;
      const dateB = b.lastActiveDate ? new Date(b.lastActiveDate).getTime() : 0;
      compareValue = dateA - dateB;
    }

    return sortDirection === 'asc' ? compareValue : -compareValue;
  });

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">User Management</h1>
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

        {/* Content */}
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
                    message.type === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Search Bar */}
          <div className="mb-6">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Icon name="search" className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search users by ID, name, username, email, groups, or auth method..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="block w-full pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoComplete="off"
              />
              {searchTerm && (
                <button
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  aria-label="Clear search"
                >
                  <Icon name="x" className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Auth Method</label>
                <select
                  value={authMethodFilter}
                  onChange={e => setAuthMethodFilter(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Methods</option>
                  <option value="local">Local</option>
                  <option value="oidc">OIDC</option>
                  <option value="proxy">Proxy</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Group</label>
                <select
                  value={groupFilter}
                  onChange={e => setGroupFilter(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Groups</option>
                  {[...new Set(users.flatMap(u => u.internalGroups || []))].map(group => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Status</label>
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Last Active</label>
                <select
                  value={lastActiveDaysFilter}
                  onChange={e => setLastActiveDaysFilter(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">Any Time</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="never">Never</option>
                </select>
              </div>
            </div>
          </div>

          {/* Users List */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Users ({sortedUsers.length}
                {searchTerm && ` of ${users.length}`})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                      onClick={() => handleSort('name')}
                    >
                      <div className="flex items-center">
                        User
                        {sortColumn === 'name' && (
                          <Icon
                            name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                            size="xs"
                            className="ml-1"
                          />
                        )}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Auth Method
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Groups
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Status
                    </th>
                    <th
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                      onClick={() => handleSort('lastActive')}
                    >
                      <div className="flex items-center">
                        Last Active
                        {sortColumn === 'lastActive' && (
                          <Icon
                            name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                            size="xs"
                            className="ml-1"
                          />
                        )}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedUsers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                        <Icon name="users" size="lg" className="mx-auto mb-4 text-gray-400" />
                        {searchTerm ? (
                          <>
                            <p>No users found matching "{searchTerm}"</p>
                            <p className="text-sm">Try adjusting your search criteria</p>
                          </>
                        ) : (
                          <>
                            <p>No users found</p>
                            <p className="text-sm">Create your first user to get started</p>
                          </>
                        )}
                      </td>
                    </tr>
                  ) : (
                    sortedUsers.map(user => (
                      <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-10 w-10">
                              <div className="h-10 w-10 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                                <Icon name="user" size="md" className="text-gray-600 dark:text-gray-300" />
                              </div>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                {user.name || user.username}
                              </div>
                              <div className="text-sm text-gray-500 dark:text-gray-400">{user.email}</div>
                              <div className="text-xs text-gray-400 dark:text-gray-500">@{user.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex flex-col">
                            <div className="flex flex-wrap gap-1">
                              {(user.authMethods || ['local']).map((method, index) => (
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
                                    name={
                                      method === 'local'
                                        ? 'key'
                                        : method === 'oidc'
                                          ? 'globe'
                                          : 'shield'
                                    }
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
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Proxy</div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex flex-wrap gap-1">
                            {(user.internalGroups || []).map((group, index) => (
                              <span
                                key={index}
                                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
                              >
                                {group}
                              </span>
                            ))}
                            {(!user.internalGroups || user.internalGroups.length === 0) && (
                              <span className="text-sm text-gray-400 dark:text-gray-500">No groups</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
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
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={user.active !== false}
                                onChange={() => handleToggleUserStatus(user)}
                                className="sr-only peer"
                              />
                              <div className="w-9 h-5 bg-gray-200 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                            </label>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {user.lastActiveDate ? (
                            <div className="flex flex-col">
                              <span>{new Date(user.lastActiveDate).toLocaleDateString()}</span>
                              <span className="text-xs text-gray-400 dark:text-gray-500">
                                {Math.floor(
                                  (Date.now() - new Date(user.lastActiveDate)) /
                                    (1000 * 60 * 60 * 24)
                                )}{' '}
                                days ago
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-400 dark:text-gray-500">Never</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex space-x-2">
                            <button
                              onClick={() => navigate(`/admin/users/${user.id}/view`)}
                              className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                              title="View user"
                            >
                              <Icon name="eye" size="sm" />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/users/${user.id}`)}
                              className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300"
                              title="Edit user"
                            >
                              <Icon name="edit" size="sm" />
                            </button>
                            <button
                              onClick={() => handleDeleteUser(user.id)}
                              className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                              title="Delete user"
                            >
                              <Icon name="trash" size="sm" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminUsersPage;
