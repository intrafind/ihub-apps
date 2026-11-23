// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * Step 6, who can use the models: everyone who signs in (the `authenticated`
 * group, which the other groups inherit), or the groups picked here. Groups
 * that already hold every model (`*`) are named, because they keep seeing the
 * new models whatever is chosen.
 *
 * @param {Object} props
 * @param {Object|null} props.groupsFile - `GET /admin/groups` body, null when it could not be read
 * @param {string[]} props.wildcardGroups - Group ids with `models: ["*"]`
 * @param {{ mode: 'everyone'|'groups', groupIds: string[] }} props.access
 * @param {(access: Object) => void} props.onChange
 */
function AccessStep({ groupsFile, wildcardGroups, access, onChange }) {
  const { t, i18n } = useTranslation();
  const groups = Object.entries(groupsFile?.groups || {});
  const groupName = (id, group) => getLocalizedContent(group?.name, i18n.language) || id;
  const wildcardNames = wildcardGroups
    .map(id => groupName(id, groupsFile?.groups?.[id]))
    .join(', ');

  const toggleGroup = (id, checked) => {
    const set = new Set(access.groupIds);
    if (checked) set.add(id);
    else set.delete(id);
    onChange({ ...access, groupIds: [...set] });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className={STEP_TITLE}>
          {t('admin.providers.connect.access.title', 'Who can use these models?')}
        </h2>
        <p className={STEP_INTRO}>
          {t(
            'admin.providers.connect.access.intro',
            'Grant the new models to groups. You can change this later under Groups.'
          )}
        </p>
      </div>

      {!groupsFile ? (
        <p className="rounded-md bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          {t(
            'admin.providers.connect.access.groupsUnavailable',
            'The groups could not be loaded. The models get the access the groups already grant; change it later under Groups.'
          )}
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="sr-only">
            {t('admin.providers.connect.access.title', 'Who can use these models?')}
          </legend>
          <label
            htmlFor="connect-access-everyone"
            className="grid grid-cols-[auto_1fr] items-start gap-x-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm"
          >
            <input
              id="connect-access-everyone"
              type="radio"
              name="connect-access"
              checked={access.mode === 'everyone'}
              onChange={() => onChange({ ...access, mode: 'everyone' })}
              className="row-span-2 mt-0.5 h-4 w-4 text-indigo-600"
            />
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {t('admin.providers.connect.access.everyone', 'Everyone who signs in')}
            </span>
            <span className="block text-xs text-gray-600 dark:text-gray-400">
              {t(
                'admin.providers.connect.access.everyoneHint',
                'Granted to the "authenticated" group, which every signed-in user is in.'
              )}
            </span>
          </label>
          <label
            htmlFor="connect-access-groups"
            className="grid grid-cols-[auto_1fr] items-start gap-x-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm"
          >
            <input
              id="connect-access-groups"
              type="radio"
              name="connect-access"
              checked={access.mode === 'groups'}
              onChange={() => onChange({ ...access, mode: 'groups' })}
              className="row-span-2 mt-0.5 h-4 w-4 text-indigo-600"
            />
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {t('admin.providers.connect.access.groups', 'Only the groups I pick')}
            </span>
          </label>
          {access.mode === 'groups' && (
            <div className="ml-7 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {groups.map(([id, group]) => {
                const wildcard = wildcardGroups.includes(id);
                return (
                  <label
                    key={id}
                    className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
                  >
                    <input
                      type="checkbox"
                      checked={wildcard || access.groupIds.includes(id)}
                      disabled={wildcard}
                      onChange={e => toggleGroup(id, e.target.checked)}
                      className="h-4 w-4 rounded-sm border border-gray-300 text-indigo-600"
                    />
                    {groupName(id, group)}
                    {wildcard && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('admin.providers.connect.access.allModels', '(all models)')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      )}

      {wildcardGroups.length > 0 && (
        <p
          role="note"
          className="rounded-md bg-blue-50 dark:bg-blue-900/20 p-3 text-sm text-blue-800 dark:text-blue-300"
        >
          {t(
            'admin.providers.connect.access.wildcardNote',
            'These groups can use every model, including the new ones, whatever you choose here: {{groups}}.',
            { groups: wildcardNames }
          )}
        </p>
      )}
    </div>
  );
}

export default AccessStep;
