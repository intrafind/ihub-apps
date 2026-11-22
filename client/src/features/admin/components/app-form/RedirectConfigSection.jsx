// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { CHECKBOX_CLASS } from '../formStyles';

/**
 * Redirect Configuration card — only rendered for apps with type 'redirect'.
 * Every control is tied to its label by `id`, so it has a name for a screen
 * reader and the label is a click target.
 */
function RedirectConfigSection({ app, onChange, t }) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.redirectConfig', 'Redirect Configuration')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.redirectConfigDesc', 'Configure the redirect behavior')}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="space-y-4">
            <div>
              <label
                htmlFor="app-redirect-url"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.apps.edit.redirectUrl', 'Redirect URL')}
                <span className="text-red-500 ml-1" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="app-redirect-url"
                type="url"
                aria-required="true"
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
                id="app-redirect-new-tab"
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
              <label
                htmlFor="app-redirect-new-tab"
                className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.edit.openInNewTab', 'Open in New Tab')}
              </label>
            </div>
            <div className="flex items-center">
              <input
                id="app-redirect-warning"
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
              <label
                htmlFor="app-redirect-warning"
                className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
              >
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
