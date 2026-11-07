// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminTabs from './AdminTabs';
import useAdminPageAccess from '../hooks/useAdminPageAccess';

/**
 * Shared header (title + description + tabs) of the models area.
 *
 * Models and the providers that serve them are one job — make models available
 * to apps — so they share one sidebar entry and one tab bar. Each tab is its own
 * route (`/admin/models`, `/admin/providers`), which keeps both deep-linkable and
 * leaves every existing link working.
 *
 * @param {Object} props
 * @param {number} [props.modelCount] Count badge for the Models tab
 * @param {number} [props.providerCount] Count badge for the Providers tab
 * @param {React.ReactNode} [props.actions] The tab's primary actions, shown beside the title
 */
function ModelsTabsHeader({ modelCount, providerCount, actions }) {
  const { t } = useTranslation();
  // Each page keeps its own permission (`admin.pages.models` / `admin.pages.providers`).
  const access = useAdminPageAccess();
  const location = useLocation();
  const navigate = useNavigate();

  const tabs = [
    ...(access.models
      ? [
          {
            id: 'models',
            label: t('admin.models.tabs.models', 'Models'),
            count: typeof modelCount === 'number' ? modelCount : undefined
          }
        ]
      : []),
    ...(access.providers
      ? [
          {
            id: 'providers',
            label: t('admin.models.tabs.providers', 'Providers'),
            count: typeof providerCount === 'number' ? providerCount : undefined
          }
        ]
      : [])
  ];

  const activeId = location.pathname.startsWith('/admin/providers') ? 'providers' : 'models';

  const handleChange = id => {
    if (id === activeId) return;
    navigate(id === 'providers' ? '/admin/providers' : '/admin/models');
  };

  return (
    <div className="mb-6">
      <div className="sm:flex sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.models.areaTitle', 'Models')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.models.areaSubtitle',
              'Connect AI providers and choose the models your apps can use'
            )}
          </p>
        </div>
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2 sm:mt-0">{actions}</div>}
      </div>
      {tabs.length > 1 && (
        <div className="mt-4">
          <AdminTabs
            tabs={tabs}
            activeId={activeId}
            onChange={handleChange}
            ariaLabel={t('admin.models.tabs.aria', 'Models sections')}
          />
        </div>
      )}
    </div>
  );
}

export default ModelsTabsHeader;
