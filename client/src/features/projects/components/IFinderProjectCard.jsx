// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ProjectPanelRow, { PANEL_CARD } from './ProjectPanelRow';

/**
 * Where a smart collection from iFinder lives, what can be done with it here,
 * and how full it is: the side panel of a collection reached by its own id, and
 * the card below the settings of a collection's project. Members and a catalog
 * entry do not exist for it.
 *
 * @param {Object} props
 * @param {{usage?: {items?: number}}} props.project
 * @param {{ifinder?: {maxDocuments?: number}}|null} [props.config]
 * @param {boolean} [props.editable=false] - The owner may add and remove documents here.
 * @returns {JSX.Element}
 */
function IFinderProjectCard({ project, config = null, editable = false }) {
  const { t } = useTranslation();
  const max = config?.ifinder?.maxDocuments;
  return (
    <div className={`${PANEL_CARD} self-start min-w-0`} data-testid="project-side-panel">
      <ProjectPanelRow
        icon="magnifying-glass"
        title={t('projects.ifinder.sourceTitle', 'Smart collection in iFinder')}
        titleId="project-ifinder-source"
        testId="project-ifinder-source"
      >
        <p className="text-gray-600 dark:text-gray-400">
          {editable
            ? t(
                'projects.ifinder.sourceTextManage',
                'Its documents stay in iFinder and are read with your own access rights. You can rename the collection and add or remove documents here, and the change is made in iFinder. Share it in iFinder.'
              )
            : t(
                'projects.ifinder.sourceText',
                'Its documents stay in iFinder and are read with your own access rights. Add, remove, rename or share them in iFinder.'
              )}
        </p>
        <p className="mt-1.5 text-gray-500 dark:text-gray-400">
          {max
            ? t('projects.ifinder.documentCountOf', '{{count}} of {{max}} documents', {
                count: project.usage?.items ?? 0,
                max
              })
            : t('projects.ifinder.documentCount', '{{count}} documents', {
                count: project.usage?.items ?? 0
              })}
        </p>
      </ProjectPanelRow>
    </div>
  );
}

export default IFinderProjectCard;
