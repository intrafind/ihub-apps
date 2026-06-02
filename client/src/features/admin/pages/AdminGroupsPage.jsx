import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { DataTable } from '../components/data-table';

const PROTECTED_GROUP_IDS = ['admin', 'user', 'anonymous', 'authenticated'];

function GroupCell({ group }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-10 w-10">
        <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
          <Icon name="users" size="md" className="text-gray-600 dark:text-gray-300" />
        </div>
      </div>
      <div className="ml-4 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {group.name}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{group.description}</div>
        <div className="text-xs text-gray-400 dark:text-gray-500">ID: {group.id}</div>
      </div>
    </div>
  );
}

function PermissionsCell({ group, t }) {
  const apps = group.permissions?.apps || [];
  const isWildcard = apps.includes('*');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1 items-center">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t('admin.groups.apps', 'Apps:')}
        </span>
        {isWildcard ? (
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300">
            All Apps (*)
          </span>
        ) : (
          <>
            {apps.slice(0, 3).map((app, index) => (
              <span
                key={index}
                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
              >
                {app}
              </span>
            ))}
            {apps.length > 3 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                +{apps.length - 3} more
              </span>
            )}
          </>
        )}
      </div>
      {group.permissions?.adminAccess && (
        <div>
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300">
            Admin Access
          </span>
        </div>
      )}
    </div>
  );
}

function MappingsCell({ group, t }) {
  const mappings = group.mappings || [];
  if (mappings.length === 0) {
    return (
      <span className="text-sm text-gray-400 dark:text-gray-500">
        {t('admin.groups.noMappings', 'No mappings')}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {mappings.map((mapping, index) => (
        <span
          key={index}
          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
        >
          {mapping}
        </span>
      ))}
    </div>
  );
}

function AdminGroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState({});
  const [message, setMessage] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    loadGroups();
  }, []);

  const loadGroups = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups');
      const data = response.data;
      setGroups(data.groups || {});
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to load groups: ${error.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteGroup = (groupId, groupName) => {
    setConfirmDialog({
      title: t('admin.groups.deleteTitle', 'Delete Group'),
      message: t(
        'admin.groups.deleteConfirm',
        'Are you sure you want to delete the group "{{name}}"?',
        { name: groupName }
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/admin/groups/${groupId}`, { method: 'DELETE' });
          setMessage({ type: 'success', text: 'Group deleted successfully!' });
          loadGroups();
        } catch (error) {
          setMessage({ type: 'error', text: `Failed to delete group: ${error.message}` });
        }
      }
    });
  };

  const groupsArray = Object.values(groups);

  const columns = [
    {
      key: 'name',
      header: t('admin.groups.fields.group', 'Group'),
      sortable: true,
      sortAccessor: g => g.name || g.id,
      render: g => <GroupCell group={g} />
    },
    {
      key: 'permissions',
      header: t('admin.groups.fields.permissions', 'Permissions'),
      render: g => <PermissionsCell group={g} t={t} />
    },
    {
      key: 'mappings',
      header: t('admin.groups.fields.mappings', 'External Mappings'),
      hideBelow: 'md',
      render: g => <MappingsCell group={g} t={t} />
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('common.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: g => navigate(`/admin/groups/${g.id}`)
    },
    {
      id: 'delete',
      label: t('common.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      hidden: g => PROTECTED_GROUP_IDS.includes(g.id),
      onClick: g => handleDeleteGroup(g.id, g.name)
    }
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
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
                  message.type === 'success'
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {message.text}
              </p>
            </div>
          </div>
        )}

        <div className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.groups.count', '{{count}} groups', { count: groupsArray.length })}
        </div>

        <DataTable
          columns={columns}
          data={groupsArray}
          getRowId={g => g.id}
          actions={actions}
          loading={loading}
          empty={{
            icon: 'users',
            title: t('admin.groups.noGroupsFound', 'No groups found'),
            description: t(
              'admin.groups.createFirstGroup',
              'Create your first group to get started'
            )
          }}
        />
      </div>
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminGroupsPage;
