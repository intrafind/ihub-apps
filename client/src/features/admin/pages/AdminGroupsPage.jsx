import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
      const response = await makeAdminApiCall('/admin/groups');
      const data = response.data;
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
      await makeAdminApiCall(`/admin/groups/${groupId}`, {
        method: 'DELETE'
      });

      // Success - axios doesn't have response.ok, successful responses are returned directly
      setMessage({
        type: 'success',
        text: 'Group deleted successfully!'
      });
      loadGroups();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to delete group: ${error.message}`
      });
    }
  };

  const isProtectedGroup = groupId => {
    return ['admin', 'user', 'anonymous', 'authenticated'].includes(groupId);
  };

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

  const groupsArray = Object.values(groups);

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {t('admin.groups.management', 'Group Management')}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  {t(
                    'admin.groups.subtitle',
                    'Manage user groups, permissions, and external group mappings'
                  )}
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

          {/* Groups List */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Groups ({groupsArray.length})</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Group
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Permissions
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      External Mappings
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {groupsArray.length === 0 ? (
                    <tr>
                      <td colSpan="4" className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                        <Icon name="users" size="lg" className="mx-auto mb-4 text-gray-400" />
                        <p>{t('admin.groups.noGroupsFound', 'No groups found')}</p>
                        <p className="text-sm">
                          {t(
                            'admin.groups.createFirstGroup',
                            'Create your first group to get started'
                          )}
                        </p>
                      </td>
                    </tr>
                  ) : (
                    groupsArray.map(group => (
                      <tr key={group.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-10 w-10">
                              <div className="h-10 w-10 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                                <Icon name="users" size="md" className="text-gray-600 dark:text-gray-300" />
                              </div>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{group.name}</div>
                              <div className="text-sm text-gray-500 dark:text-gray-400">{group.description}</div>
                              <div className="text-xs text-gray-400 dark:text-gray-500">ID: {group.id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="space-y-1">
                            <div className="flex flex-wrap gap-1">
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('admin.groups.apps', 'Apps:')}
                              </span>
                              {group.permissions?.apps?.includes('*') ? (
                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300">
                                  All Apps (*)
                                </span>
                              ) : (
                                <>
                                  {(group.permissions?.apps || []).slice(0, 3).map((app, index) => (
                                    <span
                                      key={index}
                                      className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
                                    >
                                      {app}
                                    </span>
                                  ))}
                                  {(group.permissions?.apps || []).length > 3 && (
                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                      +{(group.permissions?.apps || []).length - 3} more
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            {group.permissions?.adminAccess && (
                              <div className="flex items-center">
                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300">
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
                                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                              >
                                {mapping}
                              </span>
                            ))}
                            {(!group.mappings || group.mappings.length === 0) && (
                              <span className="text-sm text-gray-400 dark:text-gray-500">
                                {t('admin.groups.noMappings', 'No mappings')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex space-x-2">
                            <button
                              onClick={() => navigate(`/admin/groups/${group.id}`)}
                              className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300"
                            >
                              <Icon name="edit" size="sm" />
                            </button>
                            {!isProtectedGroup(group.id) && (
                              <button
                                onClick={() => handleDeleteGroup(group.id, group.name)}
                                className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
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
