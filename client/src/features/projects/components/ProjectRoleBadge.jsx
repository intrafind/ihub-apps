// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

const STYLES = {
  owner: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  editor: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  user: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  catalog: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200'
};

/**
 * The caller's role on a project (spec 1 §2): owner, editor or user; a
 * project taken from the catalog, or a published admin project reached
 * without an app, shows "From the catalog", admin projects reached through an
 * app "From an app".
 *
 * @param {{project: {ownership?: string, role?: string, permissions?: {isOwner?: boolean}}}} props
 * @returns {JSX.Element}
 */
function ProjectRoleBadge({ project }) {
  const { t } = useTranslation();
  let role = 'user';
  // A published admin project reached without an app, or added from the
  // catalog, is a catalog project to its viewer.
  if (project?.ownership === 'admin') {
    role = project?.role === 'catalog' || project?.subscribed === true ? 'catalog' : 'admin';
  } else if (project?.permissions?.isOwner || project?.role === 'owner') role = 'owner';
  else if (project?.role === 'editor') role = 'editor';
  else if (project?.role === 'catalog') role = 'catalog';
  const labels = {
    owner: t('projects.roles.owner', 'Owner'),
    editor: t('projects.roles.editor', 'Editor'),
    user: t('projects.roles.user', 'User'),
    catalog: t('projects.roles.catalog', 'From the catalog'),
    admin: t('projects.roles.admin', 'From an app')
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[0.6875rem] font-semibold ${STYLES[role]}`}
    >
      {labels[role]}
    </span>
  );
}

export default ProjectRoleBadge;

/**
 * Who a user project reaches beyond its named members: "Global" when it is
 * shared with everyone signed in, "Published" when it is in the catalog.
 *
 * @param {{project: {audience?: {everyone?: boolean, catalog?: boolean}}}} props
 * @returns {JSX.Element|null}
 */
export function ProjectAudienceBadges({ project }) {
  const { t } = useTranslation();
  const audience = project?.audience || {};
  if (!audience.everyone && !audience.catalog) return null;
  const badge =
    'inline-flex items-center px-2 py-0.5 rounded-full text-[0.6875rem] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
  return (
    <>
      {audience.everyone && (
        <span
          className={badge}
          title={t('projects.audience.globalHint', 'Shared with everyone signed in')}
        >
          {t('projects.audience.global', 'Global')}
        </span>
      )}
      {audience.catalog && (
        <span
          className={badge}
          title={t('projects.audience.publishedHint', 'In the project catalog')}
        >
          {t('projects.audience.published', 'Published')}
        </span>
      )}
    </>
  );
}
