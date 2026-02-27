import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ResourceSelector from './ResourceSelector';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';

/**
 * GroupFormEditor - Form-based editor for group configuration
 */
const GroupFormEditor = ({
  value: group,
  onChange,
  onValidationChange,
  resources = { apps: [], models: [], prompts: [], workflows: [], skills: [] },
  jsonSchema
}) => {
  const { t } = useTranslation();
  const [validationErrors, setValidationErrors] = useState({});

  // Validation function
  const validateGroup = groupData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(groupData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to manual validation if no schema
      if (!groupData.id) {
        errors.id = t('admin.groups.validation.idRequired', 'Group ID is required');
      } else if (!/^[a-zA-Z0-9_-]+$/.test(groupData.id)) {
        errors.id = t(
          'admin.groups.validation.idInvalid',
          'Group ID can only contain letters, numbers, hyphens, and underscores'
        );
      }

      if (!groupData.name) {
        errors.name = t('admin.groups.validation.nameRequired', 'Group name is required');
      }
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on group changes
  useEffect(() => {
    if (group) {
      validateGroup(group);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const handleInputChange = (field, value) => {
    const updatedGroup = {
      ...group,
      [field]: value
    };
    onChange(updatedGroup);
  };

  const handlePermissionChange = (type, selectedIds) => {
    const updatedGroup = {
      ...group,
      permissions: {
        ...group.permissions,
        [type]: selectedIds
      }
    };
    onChange(updatedGroup);
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

  if (!group) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-400 dark:text-gray-500" />
        <p className="text-lg font-medium">
          {t('admin.groups.edit.noGroupData', 'No group data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="group-form-editor space-y-6">
      {/* Basic Information */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.groups.basicInformation', 'Basic Information')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.groups.basicGroupConfiguration', 'Basic group configuration and metadata')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="grid grid-cols-6 gap-6">
              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.groups.groupId', 'Group ID')}
                  {isFieldRequired('id', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  required={isFieldRequired('id', jsonSchema)}
                  value={group.id || ''}
                  onChange={e => handleInputChange('id', e.target.value)}
                  disabled={isProtectedGroup(group.id)}
                  className={`mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:bg-gray-100 dark:disabled:bg-gray-700 ${
                    validationErrors.id ? 'border-red-300' : ''
                  }`}
                  placeholder="Enter unique group ID"
                />
                {validationErrors.id && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.id}</p>
                )}
                {isProtectedGroup(group.id) && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.groups.protectedSystemGroup', 'This is a protected system group')}
                  </p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.groups.groupName', 'Group Name')}
                  {isFieldRequired('name', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  required={isFieldRequired('name', jsonSchema)}
                  value={group.name || ''}
                  onChange={e => handleInputChange('name', e.target.value)}
                  className={`mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.name ? 'border-red-300' : ''
                  }`}
                  placeholder="Enter group display name"
                />
                {validationErrors.name && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.name}</p>
                )}
              </div>

              <div className="col-span-6">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.groups.description', 'Description')}
                </label>
                <textarea
                  value={group.description || ''}
                  onChange={e => handleInputChange('description', e.target.value)}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  placeholder="Enter group description"
                />
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={group.permissions?.adminAccess || false}
                    onChange={e => handlePermissionChange('adminAccess', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.groups.adminAccess', 'Admin Access')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Allow members of this group to access administrative functions
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={group.enabled !== false}
                    onChange={e => handleInputChange('enabled', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.groups.enabled', 'Enabled')}
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* External Group Mappings */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">External Group Mappings</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Map external groups from OIDC, LDAP, or other providers to this internal group
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                External Group Names (comma-separated)
              </label>
              <input
                type="text"
                value={(group.mappings || []).join(', ')}
                onChange={e => handleMappingChange(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                placeholder="IT-Admin, Platform-Admins, HR-Team"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Enter external group names that should be mapped to this group. Users with these
                external groups will automatically be assigned to this internal group.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Permissions */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.groups.permissions', 'Permissions')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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

              {/* Workflows Permission */}
              <ResourceSelector
                label="Workflows"
                resources={resources.workflows || []}
                selectedResources={group.permissions?.workflows || []}
                onSelectionChange={selected => handlePermissionChange('workflows', selected)}
                placeholder="Search workflows to add..."
                emptyMessage="No workflows selected - users can't execute any workflows"
              />

              {/* Skills Permission */}
              <ResourceSelector
                label="Skills"
                resources={resources.skills || []}
                selectedResources={group.permissions?.skills || []}
                onSelectionChange={selected => handlePermissionChange('skills', selected)}
                placeholder="Search skills to add..."
                emptyMessage="No skills selected - users can't use any agent skills"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupFormEditor;
