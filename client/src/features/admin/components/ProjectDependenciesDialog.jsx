// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';

/** Where the admin edits each kind of dependent resource. */
const DEPENDENCY_LINKS = {
  app: id => `/admin/apps/${encodeURIComponent(id)}`,
  workflow: id => `/admin/workflows/${encodeURIComponent(id)}`,
  agent: id => `/admin/agents/${encodeURIComponent(id)}`
};

/**
 * Explains why a project cannot be deleted: the apps, workflows and agents
 * that still link it, each linking to its editor. There is no confirm
 * button; the admin has to unlink the project first.
 *
 * @param {Object} props
 * @param {{projectName: string, dependencies: Array<{type: string, id: string, name?: string}>}|null} props.blocked
 *   The refused delete, or `null` while closed.
 * @param {() => void} props.onClose
 * @returns {JSX.Element|null}
 */
function ProjectDependenciesDialog({ blocked, onClose }) {
  const { t } = useTranslation();
  const typeLabels = {
    app: t('admin.projects.dependencies.types.app', 'App'),
    workflow: t('admin.projects.dependencies.types.workflow', 'Workflow'),
    agent: t('admin.projects.dependencies.types.agent', 'Agent')
  };

  return (
    <Modal isOpen={Boolean(blocked)} onClose={onClose} labelledBy="project-dependencies-title">
      <div className="p-6 overflow-y-auto">
        <div className="flex items-start gap-3">
          <Icon name="exclamation-triangle" className="h-6 w-6 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <h3
              id="project-dependencies-title"
              className="text-lg font-medium text-gray-900 dark:text-gray-100"
            >
              {t('admin.projects.dependencies.title', 'Project is in use')}
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.projects.dependencies.message',
                '"{{name}}" cannot be deleted while these apps, workflows or agents link it. Remove the project from them first.',
                { name: blocked?.projectName ?? '' }
              )}
            </p>
            <ul className="mt-4 space-y-2" data-testid="project-dependencies">
              {(blocked?.dependencies || []).map(dependency => {
                const href = DEPENDENCY_LINKS[dependency.type]?.(dependency.id);
                const label = dependency.name || dependency.id;
                return (
                  <li
                    key={`${dependency.type}:${dependency.id}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      {typeLabels[dependency.type] || dependency.type}
                    </span>
                    {href ? (
                      <Link
                        to={href}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline truncate"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className="truncate">{label}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default ProjectDependenciesDialog;
