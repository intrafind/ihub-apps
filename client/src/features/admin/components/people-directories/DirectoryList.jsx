// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import DirectoryBadge from './DirectoryBadge';
import TransportBadge from './TransportBadge';
import { DANGER_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

/**
 * The host of an LDAP URL, or the URL itself when it does not parse.
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url || '';
  }
}

/**
 * The Directories tab: one row per directory with its name, id, source,
 * directory type, groups, an enabled switch that saves at once, badges for
 * plain-text transport and external data flow, and edit and delete actions.
 *
 * @param {Object} props
 * @param {Array<Object>} props.directories - Stored directories
 * @param {Object} props.effective - What the server resolved, by directory id
 * @param {(id: string) => string} props.presetLabel - Display name of a preset id
 * @param {string|null} props.togglingId - Directory whose switch is being saved
 * @param {(id: string, enabled: boolean) => void} props.onToggle - Switch a directory on or off
 * @param {(id: string) => void} props.onDelete - Ask to delete a directory
 */
function DirectoryList({ directories, effective, presetLabel, togglingId, onToggle, onDelete }) {
  const { t, i18n } = useTranslation();

  if (directories.length === 0) {
    return (
      <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700">
        <Icon name="user-group" className="mx-auto h-12 w-12 text-gray-500 dark:text-gray-400" />
        <h2 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('admin.peopleDirectories.list.empty', 'No people directory configured')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.peopleDirectories.list.emptyHint',
            'Add one, or use "Use for people search" on an LDAP sign-in provider in the authentication settings.'
          )}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800 shadow-xs border border-gray-200 dark:border-gray-700 rounded-lg">
      {directories.map(directory => {
        const info = effective?.[directory.id] || {};
        const name = getLocalizedContent(directory.name, i18n.language) || directory.id;
        const nameId = `pd-row-name-${directory.id}`;
        const enabled = directory.enabled !== false;
        const reusesProvider = info.sourceType
          ? info.sourceType === 'authProvider'
          : Boolean(directory.authProvider);
        const source = info.source || directory.authProvider || hostOf(directory.url);
        const external = directory.dataFlow === 'external' || info.external === true;
        const groups = Array.isArray(directory.groups) ? directory.groups : ['authenticated'];
        const problems = Array.isArray(info.problems) ? info.problems : [];
        const warnings = Array.isArray(info.warnings) ? info.warnings : [];
        const preset = info.preset || directory.preset;

        return (
          <li key={directory.id} className="px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    id={nameId}
                    className="text-base font-semibold text-gray-900 dark:text-gray-100"
                  >
                    {name}
                  </h3>
                  {info.transport === 'plaintext' && <TransportBadge transport="plaintext" />}
                  {external && (
                    <DirectoryBadge
                      tone="info"
                      icon="globe"
                      title={t(
                        'admin.peopleDirectories.list.externalHint',
                        'Search terms go to a directory run by a third party.'
                      )}
                    >
                      {t('admin.peopleDirectories.list.external', 'External')}
                    </DirectoryBadge>
                  )}
                  {problems.length > 0 && (
                    <DirectoryBadge tone="danger" icon="exclamation-triangle">
                      {t('admin.peopleDirectories.list.needsAttention', 'Needs attention')}
                    </DirectoryBadge>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-xs text-gray-600 dark:text-gray-400">
                  {directory.id}
                </p>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      {t('admin.peopleDirectories.list.source', 'Source')}
                    </dt>
                    <dd className="text-gray-900 dark:text-gray-100 break-all">
                      {reusesProvider
                        ? t(
                            'admin.peopleDirectories.list.sourceProvider',
                            'Sign-in provider {{name}}',
                            {
                              name: source
                            }
                          )
                        : source || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      {t('admin.peopleDirectories.list.preset', 'Directory type')}
                    </dt>
                    <dd className="text-gray-900 dark:text-gray-100">
                      {preset ? presetLabel(preset) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      {t('admin.peopleDirectories.list.groups', 'Groups')}
                    </dt>
                    <dd className="text-gray-900 dark:text-gray-100 break-all">
                      {groups.length === 0
                        ? t('admin.peopleDirectories.list.noGroups', 'nobody')
                        : groups
                            .map(group =>
                              group === '*'
                                ? t('admin.peopleDirectories.visibility.everyone', 'Everyone (*)')
                                : group
                            )
                            .join(', ')}
                    </dd>
                  </div>
                </dl>
                {(problems.length > 0 || warnings.length > 0) && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {problems.map(problem => (
                      <li
                        key={`p-${problem}`}
                        className="flex gap-1.5 text-red-800 dark:text-red-300"
                      >
                        <Icon name="exclamation-triangle" size="sm" className="mt-0.5 shrink-0" />
                        <span>{problem}</span>
                      </li>
                    ))}
                    {warnings.map(warning => (
                      <li
                        key={`w-${warning}`}
                        className="flex gap-1.5 text-amber-900 dark:text-amber-200"
                      >
                        <Icon name="information-circle" size="sm" className="mt-0.5 shrink-0" />
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-labelledby={nameId}
                    disabled={togglingId === directory.id}
                    onClick={() => onToggle(directory.id, !enabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:cursor-wait disabled:opacity-60 ${
                      enabled ? 'bg-blue-600' : 'bg-gray-500 dark:bg-gray-400'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                  <span
                    className="w-16 text-sm text-gray-700 dark:text-gray-300"
                    aria-hidden="true"
                  >
                    {enabled
                      ? t('admin.peopleDirectories.list.on', 'On')
                      : t('admin.peopleDirectories.list.off', 'Off')}
                  </span>
                </div>
                <Link
                  to={`/admin/integrations/people-directories/${encodeURIComponent(directory.id)}`}
                  className={SECONDARY_BUTTON_CLASS}
                  aria-label={t('admin.peopleDirectories.list.editLabel', 'Edit {{name}}', {
                    name
                  })}
                >
                  <Icon name="pencil" size="sm" />
                  {t('admin.peopleDirectories.list.edit', 'Edit')}
                </Link>
                <button
                  type="button"
                  onClick={() => onDelete(directory.id)}
                  className={DANGER_BUTTON_CLASS}
                  aria-label={t('admin.peopleDirectories.list.deleteLabel', 'Delete {{name}}', {
                    name
                  })}
                >
                  <Icon name="trash" size="sm" />
                  {t('admin.peopleDirectories.list.delete', 'Delete')}
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default DirectoryList;
