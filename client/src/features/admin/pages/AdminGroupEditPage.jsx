import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import ResourceSelector from '../components/ResourceSelector';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminGroupEditPage = () => {
  const { t } = useTranslation();
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [resources, setResources] = useState({ apps: [], models: [], prompts: [] });

  useEffect(() => {
    loadResources();
    if (groupId === 'new') {
      // Initialize new group
      setGroup({
        id: '',
        name: '',
        description: '',
        permissions: {
          apps: [],
          prompts: [],
          models: [],
          adminAccess: false
        },
        mappings: []
      });
      setLoading(false);
    } else {
      loadGroup();
    }
  }, [groupId]);

  const loadResources = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups/resources');
      const data = response.data;
      setResources(data);
    } catch (error) {
      console.error('Failed to load resources:', error);
    }
  };

  const loadGroup = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/groups');
      const data = response.data;

      const groupData = data.groups[groupId];
      if (!groupData) {
        throw new Error('Group not found');
      }

      setGroup(groupData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async e => {
    e.preventDefault();

    if (!group.id || !group.name) {
      setError('Group ID and name are required');
      return;
    }

    try {
      setSaving(true);
      const method = groupId === 'new' ? 'POST' : 'PUT';
      const url = groupId === 'new' ? '/admin/groups' : `/admin/groups/${groupId}`;

      const response = await makeAdminApiCall(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(group)
      });

      if (response.ok) {
        navigate('/admin/groups');
      } else {
        const errorData = response.data;
        throw new Error(errorData.error || 'Failed to save group');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (field, value) => {
    setGroup(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handlePermissionChange = (type, selectedIds) => {
    setGroup(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [type]: selectedIds
      }
    }));
  };

  const handleMappingChange = mappings => {
    const mappingArray = mappings
      .split(',')
      .map(m => m.trim())
      .filter(m => m.length > 0);

    handleInputChange('mappings', mappingArray);
  };

  const isProtectedGroup = groupId => {
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
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900">
              {groupId === 'new' ? 'Add New Group' : `Edit Group: ${group?.name}`}
            </h1>
            <p className="mt-2 text-sm text-gray-700">
              {groupId === 'new'
                ? 'Configure a new user group with permissions and external mappings'
                : 'Modify group settings, permissions, and external mappings'}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 sm:w-auto"
              onClick={() => navigate('/admin/groups')}
            >
              Back to Groups
            </button>
          </div>
        </div>

        <form onSubmit={handleSave} className="mt-8 space-y-6">
          {/* Basic Information */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.groups.basicInformation', 'Basic Information')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.groups.basicGroupConfiguration',
                    'Basic group configuration and metadata'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="grid grid-cols-6 gap-6">
                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.groups.groupId', 'Group ID')}
                    </label>
                    <input
                      type="text"
                      required
                      value={group.id}
                      onChange={e => handleInputChange('id', e.target.value)}
                      disabled={groupId !== 'new' || isProtectedGroup(group.id)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm disabled:bg-gray-100"
                      placeholder="Enter unique group ID"
                    />
                    {isProtectedGroup(group.id) && (
                      <p className="mt-1 text-xs text-gray-500">
                        {t('admin.groups.protectedSystemGroup', 'This is a protected system group')}
                      </p>
                    )}
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.groups.groupName', 'Group Name')}
                    </label>
                    <input
                      type="text"
                      required
                      value={group.name}
                      onChange={e => handleInputChange('name', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                      placeholder="Enter group display name"
                    />
                  </div>

                  <div className="col-span-6">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.groups.description', 'Description')}
                    </label>
                    <textarea
                      value={group.description}
                      onChange={e => handleInputChange('description', e.target.value)}
                      rows={3}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                      placeholder="Enter group description"
                    />
                  </div>

                  <div className="col-span-6">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={group.permissions?.adminAccess || false}
                        onChange={e => handlePermissionChange('adminAccess', e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900">
                        {t('admin.groups.adminAccess', 'Admin Access')}
                      </label>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Allow members of this group to access administrative functions
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* External Group Mappings */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  External Group Mappings
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Map external groups from OIDC, LDAP, or other providers to this internal group
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    External Group Names (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={(group.mappings || []).join(', ')}
                    onChange={e => handleMappingChange(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    placeholder="IT-Admin, Platform-Admins, HR-Team"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Enter external group names that should be mapped to this group. Users with these
                    external groups will automatically be assigned to this internal group.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Permissions */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.groups.permissions', 'Permissions')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Configure which apps, models, and prompts members of this group can access
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-6">
                  {/* Apps Permission */}
                  <ResourceSelector
                    label="Apps"
                    resources={resources.apps}
                    selectedResources={group.permissions?.apps || []}
                    onSelectionChange={selected => handlePermissionChange('apps', selected)}
                    placeholder="Search apps to add..."
                    emptyMessage="No apps selected - users won't see any apps"
                  />

                  {/* Models Permission */}
                  <ResourceSelector
                    label="Models"
                    resources={resources.models}
                    selectedResources={group.permissions?.models || []}
                    onSelectionChange={selected => handlePermissionChange('models', selected)}
                    placeholder="Search models to add..."
                    emptyMessage="No models selected - users can't use any AI models"
                  />

                  {/* Prompts Permission */}
                  <ResourceSelector
                    label="Prompts"
                    resources={resources.prompts}
                    selectedResources={group.permissions?.prompts || []}
                    onSelectionChange={selected => handlePermissionChange('prompts', selected)}
                    placeholder="Search prompts to add..."
                    emptyMessage="No prompts selected - users can't access any prompt templates"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => navigate('/admin/groups')}
              className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {saving ? 'Saving...' : groupId === 'new' ? 'Create Group' : 'Save Group'}
            </button>
          </div>
        </form>
      </div>
    </AdminAuth>
  );
};

export default AdminGroupEditPage;
