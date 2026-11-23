// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * The page a person sees instead of the chat of a personal app that was
 * published and whose company app they may use: a pointer to that app.
 *
 * The server decides per person whether a personal app is retired
 * (`state: 'retired'` in the answer of `GET /api/apps/{appId}`), and sends
 * nothing of the personal app with it, only the ID and the name of the
 * company app. A person who cannot use the company app never gets this page:
 * for them the personal app keeps working.
 *
 * @param {object} props
 * @param {{publishedAs?: {appId?: string, name?: object|string}}} props.app - The
 *   retired answer of the server.
 * @returns {JSX.Element}
 */
function RetiredAppPage({ app }) {
  const { t, i18n } = useTranslation();
  const companyId = app?.publishedAs?.appId || '';
  const companyName = getLocalizedContent(app?.publishedAs?.name, i18n.language) || companyId;

  return (
    <div
      data-testid="personal-app-retired"
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center"
    >
      <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-gray-100">{companyName}</h1>
      <p className="mb-4 text-gray-700 dark:text-gray-300">{t('userApps.publish.retired.title')}</p>
      {companyId && (
        <Link
          to={`/apps/${encodeURIComponent(companyId)}`}
          className="mb-4 inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          {t('userApps.publish.retired.open', { name: companyName })}
        </Link>
      )}
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('userApps.publish.retired.chats')}
      </p>
    </div>
  );
}

export default RetiredAppPage;
