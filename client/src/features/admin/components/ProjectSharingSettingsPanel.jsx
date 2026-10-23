// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchProjectSharingSettings,
  getAdminApiErrorMessage,
  saveProjectSharingSettings
} from '../../../api/adminApi';

/**
 * Who users may share their projects with (`platform.projects.sharing`):
 * specific users, groups, everyone signed in, and the catalog of published
 * projects. Full admins only: for anyone else the panel is not shown.
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
    fetchProjectSharingSettings()
      .then(sharing => {
        if (!active) return;
        setStored(sharing);
        setDraft(sharing);
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
    setDraft(previous => ({ ...previous, ...patch }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const sharing = await saveProjectSharingSettings(draft);
      setStored(sharing);
      setDraft(sharing);
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
        checked={draft[key] === true}
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
        {t('admin.projects.sharing.title', 'Sharing of user projects')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
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
