import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import UserFormEditor from '../components/UserFormEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { getSchemaByType } from '../../../utils/schemaService';
import { useAdminResourceEditor } from '../hooks/useAdminResourceEditor';
import AdminEditPageShell, {
  AdminSaveCancelButtons
} from '../../../shared/components/AdminEditPageShell';

// Generate a unique ID for new users
const generateUserId = () => `user_${crypto.randomUUID().replace(/-/g, '_')}`;

function AdminUserEditPage() {
  const { t } = useTranslation();
  const { userId } = useParams();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [jsonSchema, setJsonSchema] = useState(null);
  const [availableGroups, setAvailableGroups] = useState([]);

  const isNewUser = userId === 'new';

  const makeDefault = useCallback(
    () => ({
      id: generateUserId(),
      username: '',
      email: null,
      fullName: '',
      name: '',
      password: '',
      internalGroups: [],
      authMethods: ['local'],
      enabled: true,
      active: true
    }),
    []
  );

  const loadResource = useCallback(async id => {
    const response = await makeAdminApiCall('/admin/auth/users');
    const data = response.data;

    // Find the user by ID in the users object
    const userData = Object.values(data.users || {}).find(u => u.id === id);
    if (!userData) {
      throw new Error('User not found');
    }

    return { ...userData, password: '' };
  }, []);

  const saveResource = useCallback(async (data, id) => {
    const method = id === 'new' ? 'POST' : 'PUT';
    const url = id === 'new' ? '/admin/auth/users' : `/admin/auth/users/${id}`;

    // Check if this is a local auth user (needs password)
    const isLocalAuth =
      !data.authMethods || data.authMethods.length === 0 || data.authMethods.includes('local');

    // Prepare the data for API call
    const apiData = {
      username: data.username,
      email: data.email || null,
      name: data.fullName || data.name || '',
      // Use internalGroups, with fallback to groups for backward compatibility
      internalGroups: data.internalGroups || data.groups || [],
      active: data.enabled !== false,
      authMethods: data.authMethods || ['local']
    };

    // Only include password if it's provided
    if (data.password) {
      apiData.password = data.password;
    }

    // For new local auth users, ensure password is provided
    if (id === 'new' && isLocalAuth && !data.password) {
      throw new Error('Password is required for local authentication users');
    }

    await makeAdminApiCall(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: apiData
    });
  }, []);

  const {
    data: user,
    setData: setUser,
    loading,
    error,
    setError,
    save,
    blocker
  } = useAdminResourceEditor({ resourceId: userId, loadResource, makeDefault, saveResource });

  useEffect(() => {
    loadSchema();
    loadGroups();
  }, [userId]);

  const loadSchema = async () => {
    try {
      const schema = await getSchemaByType('user');
      setJsonSchema(schema);
    } catch (error) {
      console.error('Failed to load user schema:', error);
    }
  };

  const loadGroups = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups');
      const groups = response.data?.groups || {};
      setAvailableGroups(Object.values(groups));
    } catch (error) {
      console.error('Failed to load groups:', error);
    }
  };

  const handleSave = async data => {
    if (!data) data = user;

    if (!data.username) {
      setError('Username is required');
      return;
    }

    try {
      setSaving(true);
      await save();
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

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <Icon name="warning" size="md" className="text-red-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Error</h3>
              <div className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminEditPageShell
      loading={loading}
      outerClassName="min-h-screen bg-gray-50 dark:bg-gray-900"
      breadcrumbs={[
        { label: 'Admin', href: '/admin' },
        { label: 'Users', href: '/admin/users' },
        { label: isNewUser ? 'New User' : (user?.username ?? userId) }
      ]}
      blocker={blocker}
    >
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {isNewUser
                ? t('admin.users.edit.createTitle', 'Create New User')
                : t('admin.users.edit.editTitle', 'Edit User')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
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
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            )}
            <button
              onClick={() => navigate('/admin/users')}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
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
            jsonSchema,
            availableGroups
          }}
          jsonSchema={jsonSchema}
          title={
            isNewUser
              ? t('admin.users.edit.createTitle', 'Create New User')
              : t('admin.users.edit.editTitle', 'Edit User')
          }
        />

        {/* Save buttons */}
        <AdminSaveCancelButtons
          onCancel={() => navigate('/admin/users')}
          cancelLabel={t('admin.users.edit.cancel', 'Cancel')}
          saving={saving}
          saveLabel={t('admin.users.edit.save', isNewUser ? 'Create User' : 'Save User')}
          savingLabel={t('admin.users.edit.saving', 'Saving...')}
        />
      </form>
    </AdminEditPageShell>
  );
}

export default AdminUserEditPage;
