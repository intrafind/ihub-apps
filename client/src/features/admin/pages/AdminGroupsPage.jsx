import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminGroupsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState({});
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadGroups();
  }, []);

  const loadGroups = async () => {
    try {
      const response = await makeAdminApiCall('/api/admin/groups');
      const data = await response.json();
      setGroups(data.groups || {});
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to load groups: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };


  const handleDeleteGroup = async (groupId, groupName) => {
    if (!window.confirm(`Are you sure you want to delete the group "${groupName}"?`)) {
      return;
    }

    try {
      const response = await makeAdminApiCall(`/api/admin/groups/${groupId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setMessage({
          type: 'success',
          text: 'Group deleted successfully!'
        });
        loadGroups();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete group');
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to delete group: ${error.message}`
      });
    }
  };


  const isProtectedGroup = (groupId) => {
    return ['admin', 'user', 'anonymous', 'authenticated'].includes(groupId);
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

  const groupsArray = Object.values(groups);

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  Group Management
                </h1>
                <p className="text-gray-600 mt-1">
                  Manage user groups, permissions, and external group mappings
                </p>
              </div>
              <button
                onClick={() => navigate('/admin/groups/new')}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Icon name="plus" size="md" className="mr-2" />
                Add Group
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

          {/* Groups List */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                Groups ({groupsArray.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Group
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Permissions
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      External Mappings
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {groupsArray.length === 0 ? (
                    <tr>
                      <td colSpan="4" className="px-6 py-8 text-center text-gray-500">
                        <Icon name="users" size="lg" className="mx-auto mb-4 text-gray-400" />
                        <p>No groups found</p>
                        <p className="text-sm">Create your first group to get started</p>
                      </td>
                    </tr>
                  ) : (
                    groupsArray.map((group) => (
                      <tr key={group.id}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-10 w-10">
                              <div className="h-10 w-10 rounded-full bg-gray-300 flex items-center justify-center">
                                <Icon name="users" size="md" className="text-gray-600" />
                              </div>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900">
                                {group.name}
                              </div>
                              <div className="text-sm text-gray-500">
                                {group.description}
                              </div>
                              <div className="text-xs text-gray-400">
                                ID: {group.id}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="space-y-1">
                            <div className="flex flex-wrap gap-1">
                              <span className="text-xs text-gray-500">Apps:</span>
                              {group.permissions?.apps?.includes('*') ? (
                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  All Apps (*)
                                </span>
                              ) : (
                                <>
                                  {(group.permissions?.apps || []).slice(0, 3).map((app, index) => (
                                    <span
                                      key={index}
                                      className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                                    >
                                      {app}
                                    </span>
                                  ))}
                                  {(group.permissions?.apps || []).length > 3 && (
                                    <span className="text-xs text-gray-500">
                                      +{(group.permissions?.apps || []).length - 3} more
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            {group.permissions?.adminAccess && (
                              <div className="flex items-center">
                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                  Admin Access
                                </span>
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-1">
                            {(group.mappings || []).map((mapping, index) => (
                              <span
                                key={index}
                                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800"
                              >
                                {mapping}
                              </span>
                            ))}
                            {(!group.mappings || group.mappings.length === 0) && (
                              <span className="text-sm text-gray-400">No mappings</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex space-x-2">
                            <button
                              onClick={() => navigate(`/admin/groups/${group.id}`)}
                              className="text-blue-600 hover:text-blue-900"
                            >
                              <Icon name="edit" size="sm" />
                            </button>
                            {!isProtectedGroup(group.id) && (
                              <button
                                onClick={() => handleDeleteGroup(group.id, group.name)}
                                className="text-red-600 hover:text-red-900"
                              >
                                <Icon name="trash" size="sm" />
                              </button>
                            )}
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

export default AdminGroupsPage;