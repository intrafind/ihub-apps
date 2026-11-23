// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import { docsHelpPath } from '../utils/docsHelpTopics';

/**
 * The name of each help topic, as the link's tooltip and accessible name read it
 * ("Help: Set up models").
 *
 * @param {(key: string, fallback: string) => string} t
 * @returns {Record<string, string>}
 */
function topicLabels(t) {
  return {
    models: t('admin.docs.helpTopics.models', 'Set up models'),
    providers: t('admin.docs.helpTopics.providers', 'Connect a provider'),
    apps: t('admin.docs.helpTopics.apps', 'Build your first app'),
    prompts: t('admin.docs.helpTopics.prompts', 'Manage prompts'),
    access: t('admin.docs.helpTopics.access', 'Who can use apps, models and prompts')
  };
}

/**
 * A "?" icon link beside a page title that opens the matching section of the documentation in
 * Admin → Documentation (`/admin/docs/<page>#<section>`).
 *
 * The link navigates inside the admin UI; Ctrl/Cmd+click opens the documentation in a new tab.
 * The documentation is a page for full administrators (its API uses `adminAuth`), so the link is
 * not rendered for a content admin, who would land on an error.
 *
 * @example
 * <h1>Models</h1>
 * <DocsLink topic="models" />
 *
 * @param {Object} props
 * @param {string} props.topic A key of `DOCS_HELP_TOPICS` (`models`, `providers`, `apps`, …)
 * @param {string} [props.className] Extra classes for the link
 * @returns {JSX.Element|null}
 */
export default function DocsLink({ topic, className = '' }) {
  const { t } = useTranslation();
  const user = useOptionalAuth()?.user;
  const to = docsHelpPath(topic);
  const isContentAdminOnly = Boolean(
    user?.permissions?.contentAdmin && !user?.permissions?.adminAccess && !user?.isAdmin
  );
  if (!to || isContentAdminOnly) return null;

  const label = t('admin.docs.helpLink', 'Help: {{topic}}', {
    topic: topicLabels(t)[topic] || topic
  });

  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      data-docs-help={topic}
      className={`inline-flex shrink-0 items-center justify-center rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-indigo-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-indigo-400 ${className}`}
    >
      <QuestionMarkCircleIcon className="h-5 w-5" aria-hidden="true" />
    </Link>
  );
}
