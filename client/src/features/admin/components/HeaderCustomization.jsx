// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

function HeaderCustomization({ config, onUpdate, t }) {
  // Map config links to component format
  const mappedLinks = (config.links || []).map(link => ({
    text: link.name || link.text || { en: '' },
    href: link.url || link.href || '',
    target: link.target || '_self',
    enabled: link.enabled !== false
  }));

  const handleColorChange = color => {
    onUpdate({ defaultColor: color });
  };

  const addNavigationLink = () => {
    const newLink = {
      text: { en: 'New Link' },
      href: '/new-page',
      target: '_self',
      enabled: true
    };

    // Convert back to config format
    const configLinks = [...mappedLinks, newLink].map(link => ({
      name: link.text,
      url: link.href,
      target: link.target,
      enabled: link.enabled
    }));
    onUpdate({ links: configLinks });
  };

  const updateNavigationLink = (index, updates) => {
    const updatedLinks = [...mappedLinks];
    updatedLinks[index] = { ...updatedLinks[index], ...updates };
    // Convert back to config format
    const configLinks = updatedLinks.map(link => ({
      name: link.text,
      url: link.href,
      target: link.target,
      enabled: link.enabled
    }));
    onUpdate({ links: configLinks });
  };

  const removeNavigationLink = index => {
    const updatedLinks = [...mappedLinks];
    updatedLinks.splice(index, 1);
    // Convert back to config format
    const configLinks = updatedLinks.map(link => ({
      name: link.text,
      url: link.href,
      target: link.target,
      enabled: link.enabled
    }));
    onUpdate({ links: configLinks });
  };

  return (
    <div>
      <div className="space-y-6">
        {/* Header Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.ui.header.color', 'Header Color')}
          </label>

          <div className="flex items-center space-x-3">
            <div
              className="w-10 h-10 rounded-md border-2 border-gray-300 dark:border-gray-600 shadow-xs"
              style={{ backgroundColor: config.defaultColor || 'rgb(0, 53, 87)' }}
            />

            <input
              type="text"
              value={config.defaultColor || ''}
              onChange={e => handleColorChange(e.target.value)}
              className="flex-1 px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              placeholder="rgb(0, 53, 87)"
            />
          </div>

          {/* Color Presets */}
          <div className="flex flex-wrap gap-1 mt-2">
            {[
              'rgb(0, 53, 87)',
              '#4f46e5',
              '#7c3aed',
              '#db2777',
              '#dc2626',
              '#ea580c',
              '#d97706',
              '#16a34a',
              '#059669',
              '#0891b2',
              '#2563eb',
              '#6366f1',
              '#e11d48'
            ].map(color => (
              <button
                key={color}
                onClick={() => handleColorChange(color)}
                className="w-6 h-6 rounded-sm border border-gray-300 dark:border-gray-600 hover:scale-110 transition-transform"
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>

          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.header.colorHint',
              'Use hex colors (#4f46e5) or rgb values (rgb(79, 70, 229)). The colour applies to the classic top header (Teams, Office and Nextcloud embeds, ?sidebar=false); the sidebar layout does not use it.'
            )}
          </p>
        </div>

        {/* Navigation Links */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.ui.header.navigationLinks', 'Navigation Links')}
            </label>
            <button
              onClick={addNavigationLink}
              className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            >
              {t('admin.ui.header.addLink', 'Add Link')}
            </button>
          </div>

          <div className="space-y-4">
            {mappedLinks.map((link, index) => (
              <div
                key={index}
                className="border border-gray-200 dark:border-gray-700 rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.ui.header.link', 'Link')} {index + 1}
                  </h4>
                  <button
                    onClick={() => removeNavigationLink(index)}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    {t('admin.ui.remove', 'Remove')}
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Link Text */}
                  <div>
                    <DynamicLanguageEditor
                      label={t('admin.ui.header.linkText', 'Link Text')}
                      value={link.text || {}}
                      onChange={text => updateNavigationLink(index, { text })}
                      type="text"
                      placeholder={{
                        en: 'Link text (en)',
                        de: 'Link text (de)',
                        es: 'Link text (es)',
                        fr: 'Link text (fr)'
                      }}
                      className="mb-2"
                    />
                  </div>

                  {/* Link URL */}
                  <div>
                    <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">
                      {t('admin.ui.header.linkUrl', 'URL')}
                    </label>
                    <input
                      type="text"
                      value={link.href || ''}
                      onChange={e => updateNavigationLink(index, { href: e.target.value })}
                      placeholder="/page-url"
                      className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-sm text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                    <div className="mt-2 flex items-center space-x-4">
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={link.enabled !== false}
                          onChange={e => updateNavigationLink(index, { enabled: e.target.checked })}
                          className="rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">
                          {t('admin.ui.header.linkEnabled', 'Enabled')}
                        </span>
                      </label>
                      <select
                        aria-label={t('admin.ui.linkTarget', 'Open link in')}
                        value={link.target || '_self'}
                        onChange={e => updateNavigationLink(index, { target: e.target.value })}
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      >
                        <option value="_self">{t('admin.ui.header.samePage', 'Same Page')}</option>
                        <option value="_blank">{t('admin.ui.header.newPage', 'New Page')}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {(!mappedLinks || mappedLinks.length === 0) && (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>{t('admin.ui.header.noLinks', 'No navigation links configured')}</p>
                <p className="text-sm">
                  {t('admin.ui.header.addFirstLink', 'Click "Add Link" to get started')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default HeaderCustomization;
