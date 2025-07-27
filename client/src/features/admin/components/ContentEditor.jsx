import React, { useState } from 'react';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

const ContentEditor = ({ config, onUpdate, t }) => {
  const [activeSection, setActiveSection] = useState('title');

  const updateDisclaimer = updates => {
    const updatedConfig = {
      ...config,
      disclaimer: {
        ...config.disclaimer,
        ...updates
      }
    };
    onUpdate(updatedConfig);
  };

  const updateAppsListConfig = updates => {
    const updatedConfig = {
      ...config,
      appsList: {
        ...config.appsList,
        ...updates
      }
    };
    onUpdate(updatedConfig);
  };

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-6">
        {t('admin.ui.content.title', 'Content Management')}
      </h3>

      {/* Section Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex space-x-8" aria-label="Tabs">
          {[
            { id: 'title', label: t('admin.ui.content.siteTitle', 'Site Title'), icon: '📝' },
            { id: 'disclaimer', label: t('admin.ui.content.disclaimer', 'Disclaimer'), icon: '⚠️' },
            { id: 'pages', label: t('admin.ui.content.pageContent', 'Page Content'), icon: '📄' }
          ].map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                activeSection === section.id
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <span>{section.icon}</span>
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Site Title Section */}
      {activeSection === 'title' && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            {t(
              'admin.ui.content.titleDescription',
              'Configure the main site title displayed in the browser tab and header.'
            )}
          </p>

          <div>
            <DynamicLanguageEditor
              label={t('admin.ui.content.siteTitleLabel', 'Site Title (Multi-language)')}
              value={config.title || {}}
              onChange={title => onUpdate({ title })}
              type="text"
              placeholder={{
                en: 'Site title (en)',
                de: 'Site title (de)',
                es: 'Site title (es)',
                fr: 'Site title (fr)'
              }}
            />
            <p className="mt-2 text-sm text-gray-500">
              {t(
                'admin.ui.content.titleHint',
                'This title appears in the browser tab and header. Leave empty to use default.'
              )}
            </p>
          </div>

          {/* Title Preview */}
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
            <h4 className="text-sm font-medium text-gray-900 mb-2">
              {t('admin.ui.content.preview', 'Preview')}
            </h4>
            <div className="bg-white p-3 rounded border">
              <div className="flex items-center space-x-2 text-gray-600 text-sm">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9v-9m0-9v9"
                  />
                </svg>
                <span>{config.title?.en || 'AI Hub Apps'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Disclaimer Section */}
      {activeSection === 'disclaimer' && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            {t(
              'admin.ui.content.disclaimerDescription',
              'Configure the disclaimer popup that appears when users first visit the site.'
            )}
          </p>

          {/* Disclaimer Enabled */}
          <div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={config.disclaimer?.enabled !== false}
                onChange={e => updateDisclaimer({ enabled: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900">
                {t('admin.ui.content.disclaimerEnabled', 'Enable Disclaimer Popup')}
              </label>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {t(
                'admin.ui.content.disclaimerEnabledHint',
                'Show disclaimer popup to first-time visitors'
              )}
            </p>
          </div>

          {config.disclaimer?.enabled !== false && (
            <>
              {/* Disclaimer Title */}
              <div>
                <DynamicLanguageEditor
                  label={t('admin.ui.content.disclaimerTitle', 'Disclaimer Title')}
                  value={config.disclaimer?.title || {}}
                  onChange={title => updateDisclaimer({ title })}
                  type="text"
                  placeholder={{
                    en: 'Disclaimer title (en)',
                    de: 'Disclaimer title (de)',
                    es: 'Disclaimer title (es)',
                    fr: 'Disclaimer title (fr)'
                  }}
                />
              </div>

              {/* Disclaimer Text */}
              <div>
                <DynamicLanguageEditor
                  label={t('admin.ui.content.disclaimerText', 'Disclaimer Text')}
                  value={config.disclaimer?.text || {}}
                  onChange={text => updateDisclaimer({ text })}
                  type="textarea"
                  placeholder={{
                    en: 'Disclaimer content (en)',
                    de: 'Disclaimer content (de)',
                    es: 'Disclaimer content (es)',
                    fr: 'Disclaimer content (fr)'
                  }}
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.ui.content.disclaimerTextHint',
                    'This text appears in the disclaimer popup. HTML tags are allowed for formatting.'
                  )}
                </p>
              </div>

              {/* Disclaimer Version */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.ui.content.disclaimerVersion', 'Disclaimer Version')}
                </label>
                <input
                  type="text"
                  value={config.disclaimer?.version || ''}
                  onChange={e => updateDisclaimer({ version: e.target.value })}
                  placeholder="1.0"
                  className="block w-full max-w-xs px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.ui.content.disclaimerVersionHint',
                    'Update this to show the disclaimer again to users who have already seen it'
                  )}
                </p>
              </div>

              {/* Last Updated */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.ui.content.disclaimerUpdated', 'Last Updated')}
                </label>
                <input
                  type="date"
                  value={config.disclaimer?.updated || ''}
                  onChange={e => updateDisclaimer({ updated: e.target.value })}
                  className="block w-full max-w-xs px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.ui.content.disclaimerUpdatedHint',
                    'Date when the disclaimer was last updated'
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Page Content Section */}
      {activeSection === 'pages' && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            {t(
              'admin.ui.content.pagesDescription',
              'Configure content for main application pages like the apps list.'
            )}
          </p>

          {/* Apps List Page */}
          <div className="border border-gray-200 rounded-lg p-4">
            <h4 className="text-md font-medium text-gray-900 mb-4">
              {t('admin.ui.content.appsListPage', 'Apps List Page')}
            </h4>

            {/* Apps List Title */}
            <div className="mb-4">
              <DynamicLanguageEditor
                label={t('admin.ui.content.appsListTitle', 'Page Title')}
                value={config.appsList?.title || {}}
                onChange={title => updateAppsListConfig({ title })}
                type="text"
                placeholder={{
                  en: 'Apps page title (en)',
                  de: 'Apps page title (de)',
                  es: 'Apps page title (es)',
                  fr: 'Apps page title (fr)'
                }}
              />
            </div>

            {/* Apps List Subtitle */}
            <div className="mb-4">
              <DynamicLanguageEditor
                label={t('admin.ui.content.appsListSubtitle', 'Page Subtitle')}
                value={config.appsList?.subtitle || {}}
                onChange={subtitle => updateAppsListConfig({ subtitle })}
                type="textarea"
                placeholder={{
                  en: 'Apps page subtitle (en)',
                  de: 'Apps page subtitle (de)',
                  es: 'Apps page subtitle (es)',
                  fr: 'Apps page subtitle (fr)'
                }}
              />
            </div>

            {/* Search Configuration */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={config.appsList?.search?.enabled !== false}
                    onChange={e =>
                      updateAppsListConfig({
                        search: { ...config.appsList?.search, enabled: e.target.checked }
                      })
                    }
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="ml-2 text-sm text-gray-900">
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
                      updateAppsListConfig({
                        categories: { ...config.appsList?.categories, enabled: e.target.checked }
                      })
                    }
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="ml-2 text-sm text-gray-900">
                    {t('admin.ui.content.enableCategories', 'Enable Categories')}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContentEditor;
