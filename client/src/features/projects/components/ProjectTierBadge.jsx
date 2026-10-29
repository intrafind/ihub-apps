// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { isIFinderProject } from '../utils/projectView';

/**
 * The tier of a project that does not live in iHub: "iFinder", with a lock
 * and the reading hint, for a smart collection shown read-only (#3024).
 * Renders nothing for a project of the iHub tier.
 *
 * @param {{project: {id?: string, tier?: string}}} props
 * @returns {JSX.Element|null}
 */
function ProjectTierBadge({ project }) {
  const { t } = useTranslation();
  if (!isIFinderProject(project)) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6875rem] font-semibold bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200"
      title={t(
        'projects.tier.ifinderHint',
        'A smart collection from iFinder. iHub only reads it; change it in iFinder.'
      )}
      data-testid="project-tier-badge"
    >
      <Icon name="lock" size="xs" />
      {t('projects.tier.ifinder', 'iFinder')}
      <span className="font-normal">· {t('projects.tier.readOnly', 'read-only')}</span>
    </span>
  );
}

export default ProjectTierBadge;
