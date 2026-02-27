import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import GroupFormEditor from '../components/GroupFormEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { getSchemaByType } from '../../../utils/schemaService';

const AdminGroupEditPage = () => {
  const { t } = useTranslation();
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [resources, setResources] = useState({ apps: [], models: [], prompts: [] });
  const [jsonSchema, setJsonSchema] = useState(null);

  useEffect(() => {
    loadResources();
    loadSchema();
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
        mappings: [],
        enabled: true
      });
      setLoading(false);
    } else {
      loadGroup();
    }
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadResources = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups/resources');
      const data = response.data;
      setResources(data);
    } catch (error) {
      console.error('Failed to load resources:', error);
    }
  };

  const loadSchema = async () => {
    try {
      const schema = await getSchemaByType('group');
      setJsonSchema(schema);
    } catch (error) {
      console.error('Failed to load group schema:', error);
    }
  };

  const loadGroup = useCallback(async () => {
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
  }, [groupId]);

  const handleSave = async data => {
    if (!data) data = group;

    if (!data.id || !data.name) {
      setError('Group ID and name are required');
      return;
    }

    try {
      setSaving(true);
      const method = groupId === 'new' ? 'POST' : 'PUT';
      const url = groupId === 'new' ? '/admin/groups' : `/admin/groups/${groupId}`;

      await makeAdminApiCall(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      // Success - axios doesn't have response.ok, successful responses are returned directly
      navigate('/admin/groups');
    } catch (err) {
      setError(err.message);
      throw err; // Re-throw to let DualModeEditor handle it
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setGroup(newData);
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    await handleSave(group);
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

  if (error) {
    return (
      <AdminAuth>
        <AdminNavigation />
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
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {groupId === 'new'
                    ? t('admin.groups.edit.createTitle', 'Create New Group')
                    : t('admin.groups.edit.editTitle', 'Edit Group')}
                </h1>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {groupId === 'new'
                    ? t(
                        'admin.groups.edit.createDesc',
                        'Create a new user group with permissions and external mappings'
                      )
                    : t(
                        'admin.groups.edit.editDesc',
                        'Edit group settings, permissions, and external mappings'
                      )}
                </p>
              </div>
              <div className="flex space-x-3">
                {groupId !== 'new' && (
                  <button
                    type="button"
                    onClick={() => {
                      const dataStr = JSON.stringify(group, null, 2);
                      const dataUri =
                        'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                      const exportFileDefaultName = `group-${group.id}.json`;
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
                  onClick={() => navigate('/admin/groups')}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                  {t('admin.groups.edit.backToList', 'Back to Groups')}
                </button>
              </div>
            </div>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-8">
            <DualModeEditor
              value={group}
              onChange={handleDataChange}
              formComponent={GroupFormEditor}
              formProps={{
                resources,
                jsonSchema
              }}
              jsonSchema={jsonSchema}
              title={
                groupId === 'new'
                  ? t('admin.groups.edit.createTitle', 'Create New Group')
                  : t('admin.groups.edit.editTitle', 'Edit Group')
              }
            />

            {/* Save buttons */}
            <div className="flex justify-end space-x-4">
              <button
                type="button"
                onClick={() => navigate('/admin/groups')}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                {t('admin.groups.edit.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                    {t('admin.groups.edit.saving', 'Saving...')}
                  </>
                ) : (
                  t('admin.groups.edit.save', groupId === 'new' ? 'Create Group' : 'Save Group')
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminGroupEditPage;
