// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ProjectPanelRow, { PANEL_CARD } from './ProjectPanelRow';

/**
 * The side panel of a smart collection from iFinder: where it lives and that
 * iHub only reads it. A smart collection has no instructions, default app,
 * members or catalog entry here, so none of those rows is shown.
 *
 * @param {{project: {usage?: {items?: number}}}} props
 * @returns {JSX.Element}
 */
function IFinderProjectCard({ project }) {
  const { t } = useTranslation();
  return (
    <div className={`${PANEL_CARD} self-start min-w-0`} data-testid="project-side-panel">
      <ProjectPanelRow
        icon="magnifying-glass"
        title={t('projects.ifinder.sourceTitle', 'Smart collection in iFinder')}
        titleId="project-ifinder-source"
        testId="project-ifinder-source"
      >
        <p className="text-gray-600 dark:text-gray-400">
          {t(
            'projects.ifinder.sourceText',
            'Its documents stay in iFinder and are read with your own access rights. Add, remove, rename or share them in iFinder.'
          )}
        </p>
        <p className="mt-1.5 text-gray-500 dark:text-gray-400">
          {t('projects.ifinder.documentCount', '{{count}} documents', {
            count: project.usage?.items ?? 0
          })}
        </p>
      </ProjectPanelRow>
    </div>
  );
}

export default IFinderProjectCard;
