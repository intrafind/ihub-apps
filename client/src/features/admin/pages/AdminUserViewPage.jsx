import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminUserViewPage = () => {
  const { t } = useTranslation();
  const { userId } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadUser = async () => {
      try {
        setLoading(true);
        const response = await makeAdminApiCall('/admin/auth/users');
        const data = response.data;

        // Find the user by ID in the users object
        const userData = Object.values(data.users || {}).find(u => u.id === userId);
        if (!userData) {
          throw new Error('User not found');
        }

        setUser(userData);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadUser();
  }, [userId]);

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

  if (error || !user) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-red-50 border border-red-200 rounded-md p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <Icon name="warning" size="md" className="text-red-400" />
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">Error</h3>
                <div className="mt-2 text-sm text-red-700">{error || 'User not found'}</div>
              </div>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {t('admin.users.view.title', 'View User')}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {t('admin.users.view.description', 'View user details and permissions')}
              </p>
            </div>
            <div className="flex space-x-3">
              <button
                type="button"
                onClick={() => {
                  const dataStr = JSON.stringify(user, null, 2);
                  const dataUri =
                    'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                  const exportFileDefaultName = `user-${user.username}.json`;
                  const linkElement = document.createElement('a');
                  linkElement.setAttribute('href', dataUri);
                  linkElement.setAttribute('download', exportFileDefaultName);
                  linkElement.click();
                }}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download', 'Download')}
              </button>
              <button
                onClick={() => navigate(`/admin/users/${userId}`)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="edit" className="h-4 w-4 mr-2" />
                {t('admin.users.view.edit', 'Edit User')}
              </button>
              <button
                onClick={() => navigate('/admin/users')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('admin.users.view.backToList', 'Back to Users')}
              </button>
            </div>
          </div>
        </div>

        {/* Read-only user information */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200">
          {/* User Avatar and Basic Info */}
          <div className="px-6 py-6 border-b border-gray-200">
            <div className="flex items-center space-x-4">
              <div className="flex-shrink-0 h-20 w-20">
                <div className="h-20 w-20 rounded-full bg-gray-300 flex items-center justify-center">
                  <Icon name="user" size="lg" className="text-gray-600" />
                </div>
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900">{user.name || user.username}</h2>
                <p className="text-sm text-gray-500 mt-1">@{user.username}</p>
                <p className="text-sm text-gray-600 mt-1">{user.email}</p>
              </div>
              <div>
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                    user.active !== false
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  }`}
                >
                  {user.active !== false ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          </div>

          {/* Basic Information Section */}
          <div className="px-6 py-6 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {t('admin.users.view.basicInfo', 'Basic Information')}
            </h3>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.username', 'Username')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">{user.username}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.email', 'Email')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">{user.email || '-'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.fullName', 'Full Name')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">{user.name || '-'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.userId', 'User ID')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900 font-mono text-xs">{user.id}</dd>
              </div>
            </dl>
          </div>

          {/* Authentication Section */}
          <div className="px-6 py-6 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {t('admin.users.view.authentication', 'Authentication')}
            </h3>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.authMethods', 'Auth Methods')}
                </dt>
                <dd className="mt-2 flex flex-wrap gap-2">
                  {(user.authMethods || ['local']).map((method, index) => (
                    <span
                      key={index}
                      className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${
                        method === 'local'
                          ? 'bg-gray-100 text-gray-800'
                          : method === 'oidc'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-purple-100 text-purple-800'
                      }`}
                    >
                      <Icon
                        name={method === 'local' ? 'key' : method === 'oidc' ? 'globe' : 'shield'}
                        size="xs"
                        className="mr-1"
                      />
                      {method.toUpperCase()}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.status', 'Status')}
                </dt>
                <dd className="mt-2">
                  <span
                    className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                      user.active !== false
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {user.active !== false
                      ? t('admin.users.view.active', 'Active')
                      : t('admin.users.view.inactive', 'Inactive')}
                  </span>
                </dd>
              </div>
              {user.oidcData && (
                <div>
                  <dt className="text-sm font-medium text-gray-500">
                    {t('admin.users.view.oidcProvider', 'OIDC Provider')}
                  </dt>
                  <dd className="mt-1 text-sm text-gray-900">{user.oidcData.provider || '-'}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Groups Section */}
          <div className="px-6 py-6 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {t('admin.users.view.groups', 'Groups & Permissions')}
            </h3>
            <div>
              <dt className="text-sm font-medium text-gray-500 mb-2">
                {t('admin.users.view.internalGroups', 'Internal Groups')}
              </dt>
              <dd className="flex flex-wrap gap-2">
                {user.internalGroups && user.internalGroups.length > 0 ? (
                  user.internalGroups.map((group, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800"
                    >
                      {group}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-gray-400">
                    {t('admin.users.view.noGroups', 'No groups assigned')}
                  </span>
                )}
              </dd>
            </div>
          </div>

          {/* Activity Section */}
          <div className="px-6 py-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {t('admin.users.view.activity', 'Activity')}
            </h3>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.createdAt', 'Created At')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {user.createdAt ? new Date(user.createdAt).toLocaleString() : '-'}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.lastActive', 'Last Active')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {user.lastActiveDate ? (
                    <div className="flex flex-col">
                      <span>{new Date(user.lastActiveDate).toLocaleString()}</span>
                      <span className="text-xs text-gray-400">
                        {Math.floor(
                          (Date.now() - new Date(user.lastActiveDate)) / (1000 * 60 * 60 * 24)
                        )}{' '}
                        {t('admin.users.view.daysAgo', 'days ago')}
                      </span>
                    </div>
                  ) : (
                    t('admin.users.view.never', 'Never')
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  {t('admin.users.view.lastModified', 'Last Modified')}
                </dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {user.updatedAt ? new Date(user.updatedAt).toLocaleString() : '-'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminUserViewPage;
