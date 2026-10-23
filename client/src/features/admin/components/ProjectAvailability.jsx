// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { availabilityFlags, projectAvailability } from '../utils/projectAdmin';

/**
 * The three answers to "who can use this project", with the consequence of
 * each. Shared by the form (as choices) and the view and list (as a badge).
 *
 * @param {Function} t - The i18next translate function.
 * @returns {Array<{id: 'apps'|'everyone'|'off', icon: string, label: string,
 *   badge: string, hint: string, badgeClass: string}>}
 */
export function availabilityOptions(t) {
  return [
    {
      id: 'apps',
      icon: 'link',
      label: t('admin.projects.availability.apps.label', 'Linked apps only'),
      badge: t('admin.projects.availability.apps.badge', 'Linked apps only'),
      hint: t(
        'admin.projects.availability.apps.hint',
        'Used by the apps, workflows and agents that link it, and open to everyone who may use them.'
      ),
      badgeClass: 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
    },
    {
      id: 'everyone',
      icon: 'globe-alt',
      label: t('admin.projects.availability.everyone.label', 'Everyone signed in'),
      badge: t('admin.projects.availability.everyone.badge', 'Everyone signed in'),
      hint: t(
        'admin.projects.availability.everyone.hint',
        'Everyone signed in can read its documents and instructions and link them into their own projects, even without access to the apps that use it.'
      ),
      badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    },
    {
      id: 'off',
      icon: 'eye-slash',
      label: t('admin.projects.availability.off.label', 'Off'),
      badge: t('admin.projects.availability.off.badge', 'Off'),
      hint: t(
        'admin.projects.availability.off.hint',
        'Nothing uses it and nobody can use it. Administrators can still edit it. Use it for a draft or to pause a project.'
      ),
      badgeClass: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
    }
  ];
}

/**
 * A project's availability as a badge: text and icon, never colour alone.
 *
 * @param {Object} props
 * @param {{enabled?: boolean, published?: boolean}} props.project
 * @returns {JSX.Element}
 */
export function ProjectAvailabilityBadge({ project }) {
  const { t } = useTranslation();
  const current = availabilityOptions(t).find(option => option.id === projectAvailability(project));
  return (
    <span
      data-testid="project-availability-badge"
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full whitespace-nowrap ${current.badgeClass}`}
    >
      <Icon name={current.icon} className="h-3.5 w-3.5" />
      {current.badge}
    </span>
  );
}

/**
 * The availability of an admin project as one choice. It replaces the two
 * checkboxes Enabled and Published, which described one decision twice and
 * allowed "published but disabled". Making a project available to everyone
 * signed in opens it past the app and group restrictions of whatever links
 * it, so that choice asks first; the others do not.
 *
 * @param {Object} props
 * @param {{enabled: boolean, published: boolean}} props.value
 * @param {(flags: {enabled: boolean, published: boolean}) => void} props.onChange
 * @param {boolean} [props.compact] - Stacked rows without the icons, for the narrow edit column.
 * @returns {JSX.Element}
 */
function ProjectAvailability({ value, onChange, compact = false }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const selected = projectAvailability(value);

  const choose = id => {
    if (id === selected) return;
    if (id === 'everyone') setConfirming(true);
    else onChange(availabilityFlags(id));
  };

  return (
    <fieldset>
      <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        {t('admin.projects.availability.legend', 'Who can use this project?')}
      </legend>
      <div
        className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-3'}`}
        data-testid="project-availability"
      >
        {availabilityOptions(t).map(option => {
          const checked = option.id === selected;
          return (
            <label
              key={option.id}
              className={`relative flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-indigo-500 ${
                checked
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 dark:border-indigo-400'
                  : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/40'
              }`}
            >
              <input
                type="radio"
                name="project-availability"
                value={option.id}
                checked={checked}
                aria-describedby={`project-availability-${option.id}-hint`}
                onChange={() => choose(option.id)}
                className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 border-gray-300 focus:ring-indigo-500"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                  {!compact && <Icon name={option.icon} className="h-4 w-4 shrink-0" />}
                  {option.label}
                </span>
                <span
                  id={`project-availability-${option.id}-hint`}
                  className="mt-1 block text-xs text-gray-600 dark:text-gray-400"
                >
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        title={t('admin.projects.publish.confirmTitle', 'Make this project available to everyone?')}
        message={t(
          'admin.projects.publish.confirmMessage',
          'Everyone signed in can then read its documents and instructions and link them into their own projects, also those who may not use the apps, workflows or agents that link it. Only administrators can change it.'
        )}
        confirmLabel={t('admin.projects.publish.confirm', 'Make available')}
        onConfirm={() => {
          setConfirming(false);
          onChange(availabilityFlags('everyone'));
        }}
        onDeny={() => setConfirming(false)}
      />
    </fieldset>
  );
}

export default ProjectAvailability;
