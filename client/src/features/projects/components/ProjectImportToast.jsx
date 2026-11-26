// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ProjectImportSummary from './ProjectImportSummary';
import { projectDisplayName } from '../utils/projectView';

/**
 * The toast after "Copy to project": how many documents were added, what was
 * skipped and why, and a link to the project. It stays until it is closed: it
 * holds a link, and a skipped list takes a while to read (WCAG 2.2.1).
 *
 * @param {Object} props
 * @param {Object} props.project - The project the file was copied into.
 * @param {{added: number, skipped: Array<Object>}} props.summary
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
export default function ProjectImportToast({ project, summary, onClose }) {
  const { t, i18n } = useTranslation();
  const name = projectDisplayName(project, i18n?.language || 'en');
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-3 rounded-md bg-gray-900 px-4 py-3 text-sm text-white shadow-lg"
      data-testid="project-import-toast"
    >
      <Icon name="check-circle" size="sm" className="mt-0.5 flex-none text-green-400" />
      <div className="min-w-0 flex-1">
        <ProjectImportSummary summary={summary} projectName={name} />
        <Link
          to={`/projects/${encodeURIComponent(project.id)}`}
          className="mt-2 inline-block font-medium text-indigo-300 underline hover:text-indigo-200"
        >
          {t('projects.import.openProject', 'Open project')}
        </Link>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
        className="flex-none rounded p-0.5 text-gray-300 hover:bg-white/10 hover:text-white"
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}
