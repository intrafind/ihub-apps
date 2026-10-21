// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

const STYLES = {
  owner: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  editor: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  user: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200'
};

/**
 * The caller's role on a project (spec 1 §2): owner, editor or user; admin
 * projects reached through an app show "From an app".
 *
 * @param {{project: {ownership?: string, role?: string, permissions?: {isOwner?: boolean}}}} props
 * @returns {JSX.Element}
 */
function ProjectRoleBadge({ project }) {
  const { t } = useTranslation();
  let role = 'user';
  if (project?.ownership === 'admin') role = 'admin';
  else if (project?.permissions?.isOwner || project?.role === 'owner') role = 'owner';
  else if (project?.role === 'editor') role = 'editor';
  const labels = {
    owner: t('projects.roles.owner', 'Owner'),
    editor: t('projects.roles.editor', 'Editor'),
    user: t('projects.roles.user', 'User'),
    admin: t('projects.roles.admin', 'From an app')
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${STYLES[role]}`}
    >
      {labels[role]}
    </span>
  );
}

export default ProjectRoleBadge;
