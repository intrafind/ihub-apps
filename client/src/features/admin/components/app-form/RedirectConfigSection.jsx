// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { CHECKBOX_CLASS } from '../formStyles';

/**
 * Redirect Configuration card — only rendered for apps with type 'redirect'.
 */
function RedirectConfigSection({ app, onChange, t }) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.redirectConfig', 'Redirect Configuration')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.redirectConfigDesc', 'Configure the redirect behavior')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.redirectUrl', 'Redirect URL')}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <input
                type="url"
                value={app.redirectConfig?.url || ''}
                onChange={e =>
                  onChange('redirectConfig', {
                    ...app.redirectConfig,
                    url: e.target.value
                  })
                }
                placeholder="https://example.com"
                className="mt-1 block w-full rounded-md border border-admin-control-border dark:border-admin-control-border-dark shadow-xs focus:border-admin-accent focus:ring-admin-accent sm:text-sm"
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.redirectConfig?.openInNewTab !== false}
                onChange={e =>
                  onChange('redirectConfig', {
                    ...app.redirectConfig,
                    openInNewTab: e.target.checked
                  })
                }
                className={CHECKBOX_CLASS}
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.openInNewTab', 'Open in New Tab')}
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.redirectConfig?.showWarning !== false}
                onChange={e =>
                  onChange('redirectConfig', {
                    ...app.redirectConfig,
                    showWarning: e.target.checked
                  })
                }
                className={CHECKBOX_CLASS}
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.showWarning', 'Show Warning Before Redirect')}
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RedirectConfigSection;
