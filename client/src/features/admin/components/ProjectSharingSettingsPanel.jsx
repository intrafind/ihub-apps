// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchProjectSettings,
  getAdminApiErrorMessage,
  saveProjectSettings
} from '../../../api/adminApi';
import ProjectAppSelect from '../../projects/components/ProjectAppSelect';

const TIER_POLICIES = [
  {
    value: 'ihub',
    label: ['admin.projects.tierPolicy.ihub', 'iHub projects only'],
    help: [
      'admin.projects.tierPolicy.ihubHelp',
      'iFinder smart collections are not offered. This is the default.'
    ]
  },
  {
    value: 'both',
    label: ['admin.projects.tierPolicy.both', 'iHub projects and iFinder smart collections'],
    help: [
      'admin.projects.tierPolicy.bothHelp',
      'Users add their iFinder smart collections to their projects from the catalog, and choose the tier when they create a project.'
    ]
  },
  {
    value: 'ifinder',
    label: ['admin.projects.tierPolicy.ifinder', 'iFinder smart collections preferred'],
    help: [
      'admin.projects.tierPolicy.ifinderHelp',
      'Smart collections can be added like under "both". Local projects stay usable and can still be created.'
    ]
  }
];

/**
 * Platform settings of user projects: who users may share their projects with
 * (`platform.projects.sharing`: specific users, groups, everyone signed in and
 * the catalog of published projects) and the tier policy
 * (`platform.projects.tierPolicy`: whether iFinder smart collections can be
 * added) and the default app of project chats (`platform.projects.defaultAppId`).
 * Full admins only: for anyone else the panel is not shown.
 *
 * @returns {JSX.Element|null}
 */
function ProjectSharingSettingsPanel() {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [draft, setDraft] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    fetchProjectSettings()
      .then(settings => {
        if (!active) return;
        setStored(settings);
        setDraft(settings);
      })
      .catch(err => {
        if (!active) return;
        if (err?.response?.status === 403 || err?.response?.status === 401) setForbidden(true);
        else setError(getAdminApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  if (forbidden) return null;
  if (!draft) {
    return error ? (
      <p role="alert" className="mb-6 text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    ) : null;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const update = patch => {
    setDraft(previous => ({ ...previous, sharing: { ...previous.sharing, ...patch } }));
    setSaved(false);
  };
  const updateTierPolicy = tierPolicy => {
    setDraft(previous => ({ ...previous, tierPolicy }));
    setSaved(false);
  };
  const updateDefaultApp = defaultAppId => {
    setDraft(previous => ({ ...previous, defaultAppId }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const settings = await saveProjectSettings(draft);
      setStored(settings);
      setDraft(settings);
      setSaved(true);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key, label, help) => (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
        checked={draft.sharing[key] === true}
        onChange={e => update({ [key]: e.target.checked })}
      />
      <span>
        {label}
        {help && <span className="block text-xs text-gray-500 dark:text-gray-400">{help}</span>}
      </span>
    </label>
  );

  return (
    <details className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('admin.projects.settings.title', 'Project settings')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.projects.tierPolicy.legend', 'Where users find their projects')}
          </legend>
          {TIER_POLICIES.map(({ value, label, help }) => (
            <label
              key={value}
              className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <input
                type="radio"
                name="project-tier-policy"
                className="mt-0.5 h-4 w-4 border-gray-300 text-indigo-600"
                checked={draft.tierPolicy === value}
                onChange={() => updateTierPolicy(value)}
              />
              <span>
                {t(label[0], label[1])}
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {t(help[0], help[1])}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.tierPolicy.requirements',
              'Smart collections also need iFinder configured (Integrations → iFinder), a user with the fi_smartcollections role and iFinder 6.8 or later. Use the iFinder integration test to check them.'
            )}
          </p>
        </fieldset>
        <div className="space-y-1">
          <label
            htmlFor="project-settings-default-app"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.projects.defaultApp.label', 'Default app for project chats')}
          </label>
          <ProjectAppSelect
            id="project-settings-default-app"
            value={draft.defaultAppId || ''}
            onChange={updateDefaultApp}
            noneLabel={t('admin.projects.defaultApp.none', 'First app in the list')}
            className="block w-full max-w-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.defaultApp.help',
              'A chat in a project starts in the default app of the project; when the project has none, it starts in this app.'
            )}
          </p>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.projects.sharing.legend', 'Users may share their projects with')}
          </legend>
          {toggle('allowUsers', t('admin.projects.sharing.allowUsers', 'Specific users'))}
          {toggle('allowGroups', t('admin.projects.sharing.allowGroups', 'Groups'))}
          {toggle(
            'allowEveryone',
            t('admin.projects.sharing.allowEveryone', 'Everyone signed in'),
            t(
              'admin.projects.sharing.allowEveryoneHelp',
              'The project appears for every user, marked "Global".'
            )
          )}
          {toggle(
            'allowCatalog',
            t('admin.projects.sharing.allowCatalog', 'The project catalog'),
            t(
              'admin.projects.sharing.allowCatalogHelp',
              'Owners and editors publish a project; every user can browse the catalog and add it to their projects. Turning this off hides published projects again.'
            )
          )}
        </fieldset>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.projects.sharing.permissionHint',
            'Users also need the "projectSharing" permission of their group.'
          )}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && (
            <span className="text-sm text-green-700 dark:text-green-400">
              {t('admin.projects.sharing.saved', 'Saved')}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </details>
  );
}

export default ProjectSharingSettingsPanel;
