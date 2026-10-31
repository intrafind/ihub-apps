// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { collectionState, isIFinderProject } from '../utils/projectView';

/**
 * The tier of a project that does not live in iHub: "iFinder", for a smart
 * collection (#3024). It says "read-only" only where the caller cannot change it
 * from iHub (not the owner, or an installation that cannot serialize writes).
 * Renders nothing for a project of the iHub tier.
 *
 * @param {Object} props
 * @param {{id?: string, tier?: string, permissions?: Object}} props.project
 * @param {boolean} [props.readOnly] - Overrides what the project's permissions say (the
 *   page knows the installation's capability too).
 * @returns {JSX.Element|null}
 */
function ProjectTierBadge({ project, readOnly: readOnlyOverride }) {
  const { t } = useTranslation();
  if (!isIFinderProject(project)) return null;
  // The collection behind the project was deleted in iFinder: the project
  // keeps its chats and settings, and says so.
  if (collectionState(project) === 'deleted') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6875rem] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
        title={t(
          'projects.tier.collectionDeletedHint',
          'The smart collection of this project was deleted in iFinder.'
        )}
        data-testid="project-tier-badge"
      >
        <Icon name="exclamation-triangle" size="xs" />
        {t('projects.tier.collectionDeleted', 'Deleted in iFinder')}
      </span>
    );
  }
  const readOnly =
    readOnlyOverride ??
    (project.permissions?.canEdit !== true || project.permissions?.readOnly === true);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6875rem] font-semibold bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200"
      title={
        readOnly
          ? t(
              'projects.tier.ifinderHint',
              'A smart collection from iFinder. iHub only reads it; change it in iFinder.'
            )
          : t(
              'projects.tier.ifinderManageHint',
              'A smart collection from iFinder. You can rename it and add or remove its documents here.'
            )
      }
      data-testid="project-tier-badge"
    >
      {readOnly && <Icon name="lock" size="xs" />}
      {t('projects.tier.ifinder', 'iFinder')}
      {readOnly && (
        <span className="font-normal">· {t('projects.tier.readOnly', 'read-only')}</span>
      )}
    </span>
  );
}

export default ProjectTierBadge;
