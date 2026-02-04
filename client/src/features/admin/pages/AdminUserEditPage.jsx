import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import UserFormEditor from '../components/UserFormEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { getSchemaByType } from '../../../utils/schemaService';

const AdminUserEditPage = () => {
  const { t } = useTranslation();
  const { userId } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);

  const isNewUser = userId === 'new';

  useEffect(() => {
    loadSchema();

    if (isNewUser) {
      // Initialize new user
      setUser({
        username: '',
        email: '',
        fullName: '',
        name: '',
        password: '',
        groups: [],
        internalGroups: [],
        enabled: true,
        active: true
      });
      setLoading(false);
      setError(null); // Clear any previous errors
    } else {
      // Call loadUser directly for existing users
      const loadExistingUser = async () => {
        try {
          setLoading(true);
          const response = await makeAdminApiCall('/admin/auth/users');
          const data = response.data;

          // Find the user by ID in the users object
          const userData = Object.values(data.users || {}).find(u => u.id === userId);
          if (!userData) {
            throw new Error('User not found');
          }

          setUser({
            ...userData,
            password: ''
          });
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };
      loadExistingUser();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const loadSchema = async () => {
    try {
      const schema = await getSchemaByType('user');
      setJsonSchema(schema);
    } catch (error) {
      console.error('Failed to load user schema:', error);
    }
  };

  const handleSave = async data => {
    if (!data) data = user;

    if (!data.username || !data.email) {
      setError('Username and email are required');
      return;
    }

    try {
      setSaving(true);
      const method = isNewUser ? 'POST' : 'PUT';
      const url = isNewUser ? '/admin/auth/users' : `/admin/auth/users/${userId}`;

      // Prepare the data for API call
      const apiData = {
        username: data.username,
        email: data.email,
        name: data.fullName || data.name || '',
        internalGroups: data.groups || data.internalGroups || [],
        active: data.enabled !== false
      };

      // Only include password if it's provided
      if (data.password) {
        apiData.password = data.password;
      }

      // For new users, ensure password is provided
      if (isNewUser && !data.password) {
        throw new Error('Password is required for new users');
      }

      await makeAdminApiCall(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiData)
      });

      // Success - navigate back to users list
      navigate('/admin/users');
    } catch (err) {
      setError(err.message);
      throw err; // Re-throw to let DualModeEditor handle it
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setUser(newData);
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    await handleSave(user);
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

  if (error) {
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
                <div className="mt-2 text-sm text-red-700">{error}</div>
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
                {isNewUser
                  ? t('admin.users.edit.createTitle', 'Create New User')
                  : t('admin.users.edit.editTitle', 'Edit User')}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {isNewUser
                  ? t(
                      'admin.users.edit.createDesc',
                      'Create a new user account with permissions and settings'
                    )
                  : t('admin.users.edit.editDesc', 'Edit user account, permissions, and settings')}
              </p>
            </div>
            <div className="flex space-x-3">
              {!isNewUser && (
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
                  {t('common.download')}
                </button>
              )}
              <button
                onClick={() => navigate('/admin/users')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('admin.users.edit.backToList', 'Back to Users')}
              </button>
            </div>
          </div>
        </div>

        <form onSubmit={handleFormSubmit} className="space-y-8">
          <DualModeEditor
            value={user}
            onChange={handleDataChange}
            formComponent={UserFormEditor}
            formProps={{
              isNewUser,
              jsonSchema
            }}
            jsonSchema={jsonSchema}
            title={
              isNewUser
                ? t('admin.users.edit.createTitle', 'Create New User')
                : t('admin.users.edit.editTitle', 'Edit User')
            }
          />

          {/* Save buttons */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={() => navigate('/admin/users')}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {t('admin.users.edit.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                  {t('admin.users.edit.saving', 'Saving...')}
                </>
              ) : (
                t('admin.users.edit.save', isNewUser ? 'Create User' : 'Save User')
              )}
            </button>
          </div>
        </form>
      </div>
    </AdminAuth>
  );
};

export default AdminUserEditPage;
