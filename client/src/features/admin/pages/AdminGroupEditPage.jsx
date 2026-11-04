// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import GroupFormEditor from '../components/GroupFormEditor';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { getSchemaByType } from '../../../utils/schemaService';
import AdminLoadError from '../components/AdminLoadError';
import UsageLimitsEditor, { normalizeUsageLimits } from '../components/UsageLimitsEditor';
import { useAdminResourceEditor } from '../hooks/useAdminResourceEditor';
import AdminEditPageShell, {
  AdminSaveCancelButtons
} from '../../../shared/components/AdminEditPageShell';

function AdminGroupEditPage() {
  const { t } = useTranslation();
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [resources, setResources] = useState({
    apps: [],
    models: [],
    prompts: [],
    workflows: [],
    skills: [],
    tools: []
  });
  const [jsonSchema, setJsonSchema] = useState(null);
  // Every group, so the editor can show what this one inherits.
  const [allGroups, setAllGroups] = useState({});

  const loadResource = useCallback(async id => {
    const response = await makeAdminApiCall('/admin/groups');
    const data = response.data;

    const groupData = data.groups[id];
    if (!groupData) {
      throw new Error('Group not found');
    }
    setAllGroups(data.groups || {});

    return groupData;
  }, []);

  const makeDefault = useCallback(
    () => ({
      id: '',
      name: '',
      description: '',
      permissions: {
        apps: [],
        prompts: [],
        models: [],
        integrations: [],
        adminAccess: false
      },
      mappings: [],
      inherits: [],
      enabled: true
    }),
    []
  );

  const saveResource = useCallback(async (data, id) => {
    const method = id === 'new' ? 'POST' : 'PUT';
    const url = id === 'new' ? '/admin/groups' : `/admin/groups/${id}`;

    await makeAdminApiCall(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      // `null` clears limits saved before; the server drops empty parts.
      body: { ...data, usageLimits: normalizeUsageLimits(data.usageLimits) }
    });
  }, []);

  const {
    data: group,
    setData: setGroup,
    loading,
    error,
    save,
    blocker
  } = useAdminResourceEditor({ resourceId: groupId, loadResource, makeDefault, saveResource });

  useEffect(() => {
    void loadResources();
    void loadSchema();
    if (groupId === 'new') void loadAllGroups();
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

  const loadAllGroups = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups');
      setAllGroups(response.data?.groups || {});
    } catch (error) {
      console.error('Failed to load groups:', error);
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

  const handleSave = async data => {
    if (!data) data = group;

    if (!data.id || !data.name) {
      setSaveError('Group ID and name are required');
      return;
    }

    try {
      setSaving(true);
      setSaveError(null);
      await save();
      // Success - axios doesn't have response.ok, successful responses are returned directly
      navigate('/admin/groups');
    } catch (err) {
      setSaveError(getAdminApiErrorMessage(err));
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

  if (error) {
    return <AdminLoadError title="Error" message={error} action={null} />;
  }

  return (
    <AdminEditPageShell
      loading={loading}
      outerClassName="min-h-screen bg-gray-50 dark:bg-gray-900"
      breadcrumbs={[
        { label: 'Admin', href: '/admin' },
        { label: 'Groups', href: '/admin/groups' },
        { label: groupId === 'new' ? 'New Group' : (group?.name ?? groupId) }
      ]}
      blocker={blocker}
    >
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
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            )}
            <button
              onClick={() => navigate('/admin/groups')}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="arrow-left" className="h-4 w-4 mr-2" />
              {t('admin.groups.edit.backToList', 'Back to Groups')}
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <div className="shrink-0">
              <Icon name="warning" size="md" className="text-red-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Error</h3>
              <div className="mt-2 text-sm text-red-700 dark:text-red-300">{saveError}</div>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleFormSubmit} className="space-y-8">
        <DualModeEditor
          value={group}
          onChange={handleDataChange}
          formComponent={GroupFormEditor}
          formProps={{
            resources,
            groups: allGroups,
            jsonSchema
          }}
          jsonSchema={jsonSchema}
          title={
            groupId === 'new'
              ? t('admin.groups.edit.createTitle', 'Create New Group')
              : t('admin.groups.edit.editTitle', 'Edit Group')
          }
        />

        <UsageLimitsEditor
          level="group"
          value={group?.usageLimits}
          modelIds={group?.permissions?.models}
          onChange={usageLimits =>
            setGroup(prev => {
              const next = { ...prev };
              if (usageLimits) next.usageLimits = usageLimits;
              else delete next.usageLimits;
              return next;
            })
          }
        />

        {/* Save buttons */}
        <AdminSaveCancelButtons
          onCancel={() => navigate('/admin/groups')}
          cancelLabel={t('admin.groups.edit.cancel', 'Cancel')}
          saving={saving}
          saveLabel={t('admin.groups.edit.save', groupId === 'new' ? 'Create Group' : 'Save Group')}
          savingLabel={t('admin.groups.edit.saving', 'Saving...')}
        />
      </form>
    </AdminEditPageShell>
  );
}

export default AdminGroupEditPage;
