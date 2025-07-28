import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminUsersPage = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    name: '',
    password: '',
    confirmPassword: '',
    groups: [],
    groupsString: '', // Add separate field for groups input string
    active: true
  });

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

  const handleCreateUser = async e => {
    e.preventDefault();

    if (formData.password !== formData.confirmPassword) {
      setMessage({
        type: 'error',
        text: 'Passwords do not match'
      });
      return;
    }

    if (formData.password.length < 6) {
      setMessage({
        type: 'error',
        text: 'Password must be at least 6 characters long'
      });
      return;
    }

    // Process groups string into array
    const groupsArray = formData.groupsString
      .split(',')
      .map(g => g.trim())
      .filter(g => g.length > 0);

    try {
      const response = await makeAdminApiCall('/admin/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: formData.username,
          email: formData.email,
          name: formData.name,
          password: formData.password,
          groups: groupsArray,
          active: formData.active
        })
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: 'User created successfully!'
        });
        setShowCreateModal(false);
        resetForm();
        loadUsers();
      } else {
        const error = response.data;
        throw new Error(error.error || 'Failed to create user');
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to create user: ${error.message}`
      });
    }
  };

  const handleUpdateUser = async e => {
    e.preventDefault();

    // Process groups string into array
    const groupsArray = formData.groupsString
      .split(',')
      .map(g => g.trim())
      .filter(g => g.length > 0);

    try {
      const updateData = {
        email: formData.email,
        name: formData.name,
        groups: groupsArray,
        active: formData.active
      };

      // Only include password if it's provided
      if (formData.password) {
        if (formData.password !== formData.confirmPassword) {
          setMessage({
            type: 'error',
            text: 'Passwords do not match'
          });
          return;
        }
        if (formData.password.length < 6) {
          setMessage({
            type: 'error',
            text: 'Password must be at least 6 characters long'
          });
          return;
        }
        updateData.password = formData.password;
      }

      const response = await makeAdminApiCall(`/admin/auth/users/${editingUser.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: 'User updated successfully!'
        });
        setEditingUser(null);
        resetForm();
        loadUsers();
      } else {
        const error = response.data;
        throw new Error(error.error || 'Failed to update user');
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to update user: ${error.message}`
      });
    }
  };

  const handleDeleteUser = async userId => {
    if (!window.confirm('Are you sure you want to delete this user?')) {
      return;
    }

    try {
      const response = await makeAdminApiCall(`/admin/auth/users/${userId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: 'User deleted successfully!'
        });
        loadUsers();
      } else {
        const error = response.data;
        throw new Error(error.error || 'Failed to delete user');
      }
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
      const response = await makeAdminApiCall(`/admin/auth/users/${user.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
          groups: user.groups || [],
          active: newStatus
        })
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: `User ${newStatus ? 'enabled' : 'disabled'} successfully!`
        });
        loadUsers();
      } else {
        const error = response.data;
        throw new Error(error.error || 'Failed to update user status');
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to update user status: ${error.message}`
      });
    }
  };

  const resetForm = () => {
    setFormData({
      username: '',
      email: '',
      name: '',
      password: '',
      confirmPassword: '',
      groups: [],
      groupsString: '',
      active: true
    });
  };

  const startEdit = user => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      email: user.email || '',
      name: user.name || '',
      password: '',
      confirmPassword: '',
      groups: user.groups || [],
      groupsString: (user.groups || []).join(', '),
      active: user.active !== false
    });
  };

  const cancelEdit = () => {
    setEditingUser(null);
    resetForm();
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">User Management</h1>
                <p className="text-gray-600 mt-1">
                  Manage local authentication users and their permissions
                </p>
              </div>
              <button
                onClick={() => {
                  resetForm();
                  setShowCreateModal(true);
                }}
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
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
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
                    message.type === 'success' ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Users List */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Users ({users.length})</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Auth Method
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Groups
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Last Active
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="px-6 py-8 text-center text-gray-500">
                        <Icon name="users" size="lg" className="mx-auto mb-4 text-gray-400" />
                        <p>No users found</p>
                        <p className="text-sm">Create your first user to get started</p>
                      </td>
                    </tr>
                  ) : (
                    users.map(user => (
                      <tr key={user.id}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-10 w-10">
                              <div className="h-10 w-10 rounded-full bg-gray-300 flex items-center justify-center">
                                <Icon name="user" size="md" className="text-gray-600" />
                              </div>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900">
                                {user.name || user.username}
                              </div>
                              <div className="text-sm text-gray-500">{user.email}</div>
                              <div className="text-xs text-gray-400">@{user.username}</div>
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
                                      ? 'bg-gray-100 text-gray-800'
                                      : method === 'oidc'
                                        ? 'bg-blue-100 text-blue-800'
                                        : 'bg-purple-100 text-purple-800'
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
                              <div className="text-xs text-gray-500 mt-1">
                                {user.oidcData.provider}
                              </div>
                            )}
                            {user.proxyData && (
                              <div className="text-xs text-gray-500 mt-1">Proxy</div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex flex-wrap gap-1">
                            {(user.groups || []).map((group, index) => (
                              <span
                                key={index}
                                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                              >
                                {group}
                              </span>
                            ))}
                            {(!user.groups || user.groups.length === 0) && (
                              <span className="text-sm text-gray-400">No groups</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center space-x-3">
                            <span
                              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                user.active !== false
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
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
                              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                            </label>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {user.lastActiveDate ? (
                            <div className="flex flex-col">
                              <span>{new Date(user.lastActiveDate).toLocaleDateString()}</span>
                              <span className="text-xs text-gray-400">
                                {Math.floor(
                                  (Date.now() - new Date(user.lastActiveDate)) /
                                    (1000 * 60 * 60 * 24)
                                )}{' '}
                                days ago
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-400">Never</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex space-x-2">
                            <button
                              onClick={() => startEdit(user)}
                              className="text-blue-600 hover:text-blue-900"
                            >
                              <Icon name="edit" size="sm" />
                            </button>
                            <button
                              onClick={() => handleDeleteUser(user.id)}
                              className="text-red-600 hover:text-red-900"
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

      {/* Create/Edit User Modal */}
      {(showCreateModal || editingUser) && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {editingUser ? 'Edit User' : 'Create New User'}
              </h3>

              <form
                onSubmit={editingUser ? handleUpdateUser : handleCreateUser}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                    disabled={!!editingUser}
                    required={!editingUser}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-100"
                    placeholder="Enter username"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={e => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="Enter email"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="Enter full name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {editingUser ? 'New Password (leave blank to keep current)' : 'Password'}
                  </label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={e => setFormData(prev => ({ ...prev, password: e.target.value }))}
                    required={!editingUser}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="Enter password"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={formData.confirmPassword}
                    onChange={e =>
                      setFormData(prev => ({ ...prev, confirmPassword: e.target.value }))
                    }
                    required={!editingUser || formData.password}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="Confirm password"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Groups (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formData.groupsString}
                    onChange={e => setFormData(prev => ({ ...prev, groupsString: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="admin, user, editors"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Enter group names separated by commas
                  </p>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.active}
                      onChange={e => setFormData(prev => ({ ...prev, active: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">Active User</span>
                  </label>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button
                    type="submit"
                    className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    {editingUser ? 'Update User' : 'Create User'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      cancelEdit();
                    }}
                    className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </AdminAuth>
  );
};

export default AdminUsersPage;
