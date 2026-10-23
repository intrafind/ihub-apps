// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';

/**
 * The "Published" switch of an admin project. Publishing opens the project
 * to everyone signed in, past the app and group restrictions of whatever
 * links it, so switching it on asks first; switching it off does not.
 *
 * @param {Object} props
 * @param {boolean} props.checked
 * @param {(published: boolean) => void} props.onChange
 * @param {string} [props.className] - Classes of the label.
 * @returns {JSX.Element}
 */
function ProjectPublishedSwitch({ checked, onChange, className = '' }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <div>
      <label
        className={`flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 ${className}`}
      >
        <input
          type="checkbox"
          checked={checked}
          aria-describedby="project-published-hint"
          onChange={e => (e.target.checked ? setConfirming(true) : onChange(false))}
          className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
        />
        {t('admin.projects.fields.published', 'Published')}
      </label>
      <p
        id="project-published-hint"
        className="mt-1 max-w-xs text-xs text-gray-500 dark:text-gray-400"
      >
        {t(
          'admin.projects.fields.publishedHint',
          'Everyone signed in can use it and link its documents into their own projects, even without access to the apps that link it.'
        )}
      </p>
      <ConfirmDialog
        isOpen={confirming}
        title={t('admin.projects.publish.confirmTitle', 'Publish this project?')}
        message={t(
          'admin.projects.publish.confirmMessage',
          'Everyone signed in can then read its documents and instructions and link them into their own projects, also those who may not use the apps, workflows or agents that link it. Only administrators can change it.'
        )}
        confirmLabel={t('admin.projects.publish.confirm', 'Publish')}
        onConfirm={() => {
          setConfirming(false);
          onChange(true);
        }}
        onDeny={() => setConfirming(false)}
      />
    </div>
  );
}

export default ProjectPublishedSwitch;
