// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ResourceSelector from './ResourceSelector';
import GroupMultiSelect from './GroupMultiSelect';
import GroupIntegrationsSection from './GroupIntegrationsSection';
import {
  FIELD_KEYS,
  fieldErrorAttributes,
  fieldErrorId,
  isBlank,
  schemaFieldErrors
} from '../utils/fieldErrors';
import useAdminFormErrors from '../hooks/useAdminFormErrors';
import RequiredMark from './RequiredMark';
import AdminFormErrorFrame from './AdminFormErrorFrame';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';
import { DEFAULT_MODEL_TOKEN } from '../../../../../shared/modelPermissions.js';

const NO_IDS = Object.freeze([]);

/**
 * The choices of the group's model picker: the default-model token first, as
 * its own entry with a readable name, then every model. The token grants the
 * model that is the platform default at the time of the check
 * (`shared/modelPermissions.js`), so an admin can grant "the default model"
 * without naming one.
 *
 * @param {Array<{id: string, name?: string|Object}>} models - The configured models
 * @param {function} t - The translation function
 * @returns {Array<{id: string, name: string|Object}>}
 *
 * @example
 * modelPermissionChoices([{ id: 'gpt-4o', name: 'GPT-4o' }], t);
 * // → [{ id: '@default', name: 'Default model (whichever is set as default)' }, { id: 'gpt-4o', … }]
 */
export function modelPermissionChoices(models, t) {
  const list = Array.isArray(models) ? models : [];
  return [
    {
      id: DEFAULT_MODEL_TOKEN,
      name: t('admin.groups.form.defaultModelToken', 'Default model (whichever is set as default)')
    },
    ...list.filter(model => model?.id !== DEFAULT_MODEL_TOKEN)
  ];
}

/** The group fields with texts of their own, by schema rule (`fieldErrors.js`). */
const GROUP_FIELD_RULES = Object.freeze({
  id: { empty: FIELD_KEYS.idRequired, pattern: FIELD_KEYS.groupIdFormat },
  name: { empty: FIELD_KEYS.nameRequired }
});

/**
 * Every problem of a group, in the admin's language, by field path.
 *
 * @param {Object} group - The group as the form holds it.
 * @param {Object|null} schema - The group JSON schema; without it only the ID
 *   and the name are checked.
 * @param {function} t - The translation function.
 * @param {Object} options
 * @param {boolean} options.isNewGroup
 * @param {string[]} options.takenIds - IDs of the existing groups.
 * @returns {Object<string, string>}
 */
export function groupFieldErrors(group, schema, t, { isNewGroup, takenIds }) {
  const errors = schema ? schemaFieldErrors(group, schema, t, { rules: GROUP_FIELD_RULES }) : {};
  if (!schema) {
    if (isBlank(group.id)) errors.id = t(FIELD_KEYS.idRequired);
    if (isBlank(group.name)) errors.name = t(FIELD_KEYS.nameRequired);
  }
  if (isNewGroup && !errors.id && takenIds.includes(group.id)) {
    errors.id = t(FIELD_KEYS.idTaken);
  }
  return errors;
}

/**
 * GroupFormEditor - Form-based editor for group configuration
 *
 * A blank group shows no errors: a field says what is wrong once the admin has
 * left or changed it, and every problem shows after the first save attempt.
 *
 * @param {Object} props
 * @param {Object} props.value - The group
 * @param {Function} props.onChange - Receives the changed group
 * @param {Function} [props.onValidationChange] - Receives `{ isValid, errors, displayed }`
 * @param {boolean} [props.isNewGroup] - A group not saved yet: its ID must not be taken
 * @param {boolean} [props.showAllErrors] - Show every problem (after a save attempt)
 * @param {string[]} [props.takenIds] - IDs of the existing groups
 * @param {number} [props.summaryFocusKey] - A new value moves the focus to the error summary
 */
function GroupFormEditor({
  value: group,
  onChange,
  onValidationChange,
  resources = { apps: [], models: [], prompts: [], workflows: [], skills: [] },
  groups = {},
  jsonSchema,
  isNewGroup = false,
  showAllErrors = false,
  takenIds = NO_IDS,
  summaryFocusKey = 0
}) {
  const { t } = useTranslation();

  const modelChoices = useMemo(
    () => modelPermissionChoices(resources.models, t),
    [resources.models, t]
  );

  const allErrors = useMemo(
    () => (group ? groupFieldErrors(group, jsonSchema, t, { isNewGroup, takenIds }) : {}),
    [group, jsonSchema, t, isNewGroup, takenIds]
  );
  const { errors: validationErrors, controlHandlers } = useAdminFormErrors(allErrors, {
    showAll: showAllErrors,
    onValidationChange
  });

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

  const handleMappingChange = mappingArray => {
    handleInputChange('mappings', mappingArray);
  };

  const handleInheritsChange = inheritsArray => {
    handleInputChange('inherits', inheritsArray);
  };

  // Parent candidates: every group except this one, so a group cannot inherit itself.
  const parentCandidates = Object.values(groups || {}).filter(g => g && g.id && g.id !== group?.id);

  const isProtectedGroup = groupId => {
    return ['admins', 'users', 'anonymous', 'authenticated'].includes(groupId);
  };

  if (!group) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <Icon
          name="exclamation-triangle"
          className="h-12 w-12 mx-auto mb-4 text-gray-500 dark:text-gray-400"
        />
        <p className="text-lg font-medium">
          {t('admin.groups.edit.noGroupData', 'No group data available')}
        </p>
      </div>
    );
  }

  const errorLabels = {
    id: t('admin.groups.fields.id', 'Group ID'),
    name: t('admin.groups.fields.name', 'Name'),
    description: t('admin.groups.fields.description', 'Description')
  };

  return (
    <AdminFormErrorFrame
      className="group-form-editor space-y-6"
      errors={validationErrors}
      controlHandlers={controlHandlers}
      showSummary={showAllErrors}
      labels={errorLabels}
      title={t('admin.groups.edit.fixErrors', 'Please fix the following errors')}
      focusKey={summaryFocusKey}
    >
      {/* Basic Information */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
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
                <label
                  htmlFor="group-id"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.groups.groupId', 'Group ID')}
                  <RequiredMark />
                </label>
                <input
                  type="text"
                  id="group-id"
                  name="id"
                  required
                  {...fieldErrorAttributes('id', validationErrors.id)}
                  value={group.id || ''}
                  onChange={e => handleInputChange('id', e.target.value)}
                  disabled={isProtectedGroup(group.id)}
                  className={`${INPUT_CLASS} mt-1 block ${
                    validationErrors.id ? 'border-red-500 dark:border-red-400' : ''
                  }`}
                  placeholder={t('admin.groups.form.idPlaceholder', 'Enter unique group ID')}
                />
                {validationErrors.id && (
                  <p
                    id={fieldErrorId('id')}
                    className="mt-1 text-sm text-red-600 dark:text-red-400"
                  >
                    {validationErrors.id}
                  </p>
                )}
                {isProtectedGroup(group.id) && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.groups.protectedSystemGroup', 'This is a protected system group')}
                  </p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="group-name"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.groups.groupName', 'Group Name')}
                  <RequiredMark />
                </label>
                <input
                  type="text"
                  id="group-name"
                  name="name"
                  required
                  {...fieldErrorAttributes('name', validationErrors.name)}
                  value={group.name || ''}
                  onChange={e => handleInputChange('name', e.target.value)}
                  className={`${INPUT_CLASS} mt-1 block ${
                    validationErrors.name ? 'border-red-500 dark:border-red-400' : ''
                  }`}
                  placeholder={t('admin.groups.form.namePlaceholder', 'Enter group display name')}
                />
                {validationErrors.name && (
                  <p
                    id={fieldErrorId('name')}
                    className="mt-1 text-sm text-red-600 dark:text-red-400"
                  >
                    {validationErrors.name}
                  </p>
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
                  className={`${INPUT_CLASS} mt-1 block`}
                  placeholder={t(
                    'admin.groups.form.descriptionPlaceholder',
                    'Enter group description'
                  )}
                />
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={group.permissions?.adminAccess || false}
                    onChange={e => handlePermissionChange('adminAccess', e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.groups.adminAccess', 'Admin Access')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.form.adminAccessHelp',
                    'Allow members of this group to access administrative functions'
                  )}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={group.permissions?.contentAdmin || false}
                    onChange={e => handlePermissionChange('contentAdmin', e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.groups.contentAdmin', 'Content Admin (Apps, Prompts, Projects)')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.contentAdminHint',
                    'Allow members to manage Apps, Prompts, and Projects without full admin access'
                  )}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="group-permission-scheduled-tasks"
                    type="checkbox"
                    checked={group.permissions?.scheduledTasks || false}
                    onChange={e => handlePermissionChange('scheduledTasks', e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="group-permission-scheduled-tasks"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.groups.scheduledTasks', 'Scheduled Tasks')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.scheduledTasksHint',
                    'Allow members to create scheduled tasks that run by themselves as the member (needs the Scheduled Tasks feature). Inherited by groups that inherit this one.'
                  )}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="group-permission-projects"
                    type="checkbox"
                    checked={group.permissions?.projects || false}
                    onChange={e => handlePermissionChange('projects', e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="group-permission-projects"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.groups.projects', 'Projects')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.projectsHint',
                    'Allow members to create projects of their own: documents, instructions and chats (needs the User Projects feature). Inherited by groups that inherit this one.'
                  )}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="group-permission-project-sharing"
                    type="checkbox"
                    checked={group.permissions?.projectSharing || false}
                    onChange={e => handlePermissionChange('projectSharing', e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="group-permission-project-sharing"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.groups.projectSharing', 'Project sharing')}
                  </label>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.groups.projectSharingHint',
                    'Allow members to add other users, groups or everyone to the projects they own or edit.'
                  )}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="group-permission-user-apps"
                    type="checkbox"
                    checked={group.permissions?.userApps || false}
                    onChange={e => handlePermissionChange('userApps', e.target.checked)}
                    aria-describedby="group-permission-user-apps-hint"
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="group-permission-user-apps"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.userApps.groups.userApps')}
                  </label>
                </div>
                <p
                  id="group-permission-user-apps-hint"
                  className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                >
                  {t('admin.userApps.groups.userAppsHint')}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="group-permission-user-app-sharing"
                    type="checkbox"
                    checked={group.permissions?.userAppSharing || false}
                    onChange={e => handlePermissionChange('userAppSharing', e.target.checked)}
                    aria-describedby="group-permission-user-app-sharing-hint"
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="group-permission-user-app-sharing"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.userApps.groups.userAppSharing')}
                  </label>
                </div>
                <p
                  id="group-permission-user-app-sharing-hint"
                  className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                >
                  {t('admin.userApps.groups.userAppSharingHint')}
                </p>
              </div>

              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={group.enabled !== false}
                    onChange={e => handleInputChange('enabled', e.target.checked)}
                    className={CHECKBOX_CLASS}
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

      {/* Inherited Groups */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.groups.inheritance', 'Group Inheritance')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.groups.inheritanceDescription',
                'Optionally let this group inherit the permissions of one or more parent groups'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <GroupMultiSelect
              id="group-inherits"
              label={t('admin.groups.inheritsFrom', 'Inherits From')}
              value={group.inherits || []}
              onChange={handleInheritsChange}
              availableGroups={parentCandidates}
              allowCustom={false}
              placeholder={t('admin.groups.inheritsPlaceholder', 'Search groups to inherit from…')}
              emptyMessage={t(
                'admin.groups.inheritsEmpty',
                'No parent groups - this group only has its own permissions'
              )}
              helpText={t(
                'admin.groups.inheritsHelp',
                "Members of this group also get the permissions of every parent group (combined, never reduced). The group's own permissions are added on top. Inheritance is optional, and circular inheritance is rejected when you save."
              )}
            />
          </div>
        </div>
      </div>

      {/* External Group Mappings */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.groups.externalMappings', 'External Group Mappings')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.groups.externalMappingsDescription',
                'Map external groups from OIDC, LDAP, or other providers to this internal group'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <GroupMultiSelect
              id="group-external-mappings"
              label={t('admin.groups.externalGroupNames', 'External Group Names')}
              value={group.mappings || []}
              onChange={handleMappingChange}
              warnOnCustom={false}
              placeholder={t(
                'admin.groups.externalMappingsPlaceholder',
                'Type a group name and press Enter…'
              )}
              emptyMessage={t('admin.groups.externalMappingsEmpty', 'No external mappings yet')}
              helpText={t(
                'admin.groups.externalMappingsHelp',
                'Enter external group names that should be mapped to this group. Users with these external groups will automatically be assigned to this internal group.'
              )}
            />
          </div>
        </div>
      </div>

      {/* Permissions */}
      <div className="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/20 px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.groups.permissions', 'Permissions')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.groups.form.permissionsHelp',
                'Configure which apps, models, and prompts members of this group can access'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-6">
              {/* Apps Permission */}
              <ResourceSelector
                label={t('admin.nav.apps', 'Apps')}
                resources={resources.apps}
                selectedResources={group.permissions?.apps || []}
                onSelectionChange={selected => handlePermissionChange('apps', selected)}
                placeholder={t('admin.groups.form.searchApps', 'Search apps to add…')}
                emptyMessage={t(
                  'admin.groups.form.noApps',
                  'No apps selected – users won’t see any apps'
                )}
              />

              {/* Models Permission */}
              <ResourceSelector
                label={t('admin.nav.models', 'Models')}
                resources={modelChoices}
                selectedResources={group.permissions?.models || []}
                onSelectionChange={selected => handlePermissionChange('models', selected)}
                placeholder={t('admin.groups.form.searchModels', 'Search models to add…')}
                emptyMessage={t(
                  'admin.groups.form.noModels',
                  'No models selected – users can’t use any AI models'
                )}
              />

              {/* Prompts Permission */}
              <ResourceSelector
                label={t('admin.nav.prompts', 'Prompts')}
                resources={resources.prompts}
                selectedResources={group.permissions?.prompts || []}
                onSelectionChange={selected => handlePermissionChange('prompts', selected)}
                placeholder={t('admin.groups.form.searchPrompts', 'Search prompts to add…')}
                emptyMessage={t(
                  'admin.groups.form.noPrompts',
                  'No prompts selected – users can’t access any prompt templates'
                )}
              />

              {/* Workflows Permission */}
              <ResourceSelector
                label={t('admin.nav.workflows', 'Workflows')}
                resources={resources.workflows || []}
                selectedResources={group.permissions?.workflows || []}
                onSelectionChange={selected => handlePermissionChange('workflows', selected)}
                placeholder={t('admin.groups.form.searchWorkflows', 'Search workflows to add…')}
                emptyMessage={t(
                  'admin.groups.form.noWorkflows',
                  'No workflows selected – users can’t run any workflows'
                )}
              />

              {/* Skills Permission */}
              <ResourceSelector
                label={t('admin.nav.skills', 'Skills')}
                resources={resources.skills || []}
                selectedResources={group.permissions?.skills || []}
                onSelectionChange={selected => handlePermissionChange('skills', selected)}
                placeholder={t('admin.groups.form.searchSkills', 'Search skills to add…')}
                emptyMessage={t(
                  'admin.groups.form.noSkills',
                  'No skills selected – users can’t use any agent skills'
                )}
              />

              {/* Integrations Permission (#3093) */}
              <GroupIntegrationsSection
                group={group}
                groups={groups}
                onChange={selected => handlePermissionChange('integrations', selected)}
              />
            </div>
          </div>
        </div>
      </div>
    </AdminFormErrorFrame>
  );
}

export default GroupFormEditor;
