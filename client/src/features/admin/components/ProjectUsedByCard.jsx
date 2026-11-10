// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchAdminProjectDependencies } from '../../../api/adminApi';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { projectDependencyHref } from '../utils/projectAdmin';

/**
 * The apps, workflows and agents that link one admin project.
 *
 * @param {{projectId: string}} props
 * @returns {JSX.Element}
 */
function ProjectUsedByCard({ projectId }) {
  const { t } = useTranslation();
  const featureFlags = useFeatureFlags();
  // `null` until the lookup answered; an error is not an empty list.
  const [dependencies, setDependencies] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDependencies(null);
    setFailed(false);
    fetchAdminProjectDependencies(projectId)
      .then(result => {
        if (!cancelled) setDependencies(result);
      })
      .catch(err => {
        console.error('Failed to load project links:', err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const typeLabels = {
    app: t('admin.projects.dependencies.types.app', 'App'),
    workflow: t('admin.projects.dependencies.types.workflow', 'Workflow'),
    agent: t('admin.projects.dependencies.types.agent', 'Agent')
  };

  let body;
  if (failed) {
    body = (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {t(
          'admin.projects.view.usedByFailed',
          'The apps, workflows and agents that link this project could not be loaded.'
        )}
      </p>
    );
  } else if (dependencies === null) {
    body = (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('common.loading', 'Loading...')}
      </p>
    );
  } else if (dependencies.length === 0) {
    body = (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('admin.projects.view.notLinked', 'No app, workflow or agent links this project.')}
      </p>
    );
  } else {
    body = (
      <ul className="space-y-2" data-testid="project-dependencies">
        {dependencies.map(dependency => {
          const href = projectDependencyHref(dependency, featureFlags);
          const label = dependency.name || dependency.id;
          return (
            <li
              key={`${dependency.type}:${dependency.id}:${dependency.nodeId || ''}`}
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
    );
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6">
      <h2 className="mb-3 text-lg font-medium text-gray-900 dark:text-gray-100">
        {t('admin.projects.view.usedBy', 'Used by')}
      </h2>
      {body}
    </section>
  );
}

export default ProjectUsedByCard;
