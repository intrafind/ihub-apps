// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

/**
 * The apps browser page (`/apps`): its title, subtitle, logo and whether it offers
 * search and categories. Lives next to the start page, the other page the
 * admin shapes for visitors.
 *
 * @param {Object} props
 * @param {Object} props.config - The whole ui.json
 * @param {(section: string, updates: Object) => void} props.onUpdate - Merge `updates` into a section
 */
function AppsListCustomization({ config, onUpdate, t }) {
  const updateAppsList = updates => onUpdate('appsList', updates);
  const updateIcons = updates => onUpdate('icons', updates);

  return (
    <div className="space-y-6">
      {/* Apps List Page */}
      <div>
        {/* Apps List Title */}
        <div className="mb-4">
          <DynamicLanguageEditor
            label={t('admin.ui.content.appsListTitle', 'Page Title')}
            value={config.appsList?.title || {}}
            onChange={title => updateAppsList({ title })}
            type="text"
            placeholder={{
              en: 'Apps page title',
              de: 'Titel der Apps-Seite',
              es: 'Título de la página de apps',
              fr: 'Titre de la page des apps'
            }}
          />
        </div>

        {/* Apps List Subtitle */}
        <div className="mb-4">
          <DynamicLanguageEditor
            label={t('admin.ui.content.appsListSubtitle', 'Page Subtitle')}
            value={config.appsList?.subtitle || {}}
            onChange={subtitle => updateAppsList({ subtitle })}
            type="textarea"
            placeholder={{
              en: 'Apps page subtitle',
              de: 'Untertitel der Apps-Seite',
              es: 'Subtítulo de la página de apps',
              fr: 'Sous-titre de la page des apps'
            }}
          />
        </div>

        {/* Apps List Logo */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.ui.content.appsListLogo', 'Page Logo')}
          </label>
          <input
            type="text"
            value={config.icons?.appsListLogo || ''}
            onChange={e => updateIcons({ appsListLogo: e.target.value })}
            placeholder={t(
              'admin.ui.content.appsListLogoPlaceholder',
              '/uploads/assets/my-logo.svg'
            )}
            className="block w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          />
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.content.appsListLogoHint',
              'Upload an icon in the Assets tab, then paste the URL here. Leave empty for the default icon.'
            )}
          </p>
          {config.icons?.appsListLogo && (
            <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                {t('admin.ui.content.preview', 'Preview')}
              </p>
              <div className="flex items-center justify-center bg-white dark:bg-gray-700 p-3 rounded-sm">
                <img
                  src={config.icons.appsListLogo}
                  alt={t('admin.ui.content.appsListLogoAlt', 'Apps List Logo')}
                  className="w-16 h-16 object-contain"
                  onError={e => {
                    e.target.style.display = 'none';
                    e.target.nextElementSibling.style.display = 'block';
                  }}
                />
                <p className="hidden text-sm text-red-500 dark:text-red-400">
                  {t('admin.ui.content.iconPreviewError', 'Failed to load icon preview')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Search Configuration */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={config.appsList?.search?.enabled !== false}
                onChange={e =>
                  updateAppsList({
                    search: { ...config.appsList?.search, enabled: e.target.checked }
                  })
                }
                className="rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="ml-2 text-sm text-gray-900 dark:text-gray-100">
                {t('admin.ui.content.enableSearch', 'Enable Search')}
              </span>
            </label>
          </div>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={config.appsList?.categories?.enabled !== false}
                onChange={e =>
                  updateAppsList({
                    categories: { ...config.appsList?.categories, enabled: e.target.checked }
                  })
                }
                className="rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="ml-2 text-sm text-gray-900 dark:text-gray-100">
                {t('admin.ui.content.enableCategories', 'Enable Categories')}
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppsListCustomization;
