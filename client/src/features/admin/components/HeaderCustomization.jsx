import React, { useState } from 'react';

const HeaderCustomization = ({ config, onUpdate, t }) => {
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  const handleColorChange = (color) => {
    onUpdate({ defaultColor: color });
  };

  const handleLogoUrlChange = (url) => {
    onUpdate({
      logo: {
        ...config.logo,
        url
      }
    });
  };

  const handleLogoAltChange = (lang, altText) => {
    onUpdate({
      logo: {
        ...config.logo,
        alt: {
          ...config.logo?.alt,
          [lang]: altText
        }
      }
    });
  };

  const handleTitleChange = (lang, title) => {
    onUpdate({
      title: {
        ...config.title,
        [lang]: title
      }
    });
  };

  const addNavigationLink = () => {
    const newLink = {
      text: { en: 'New Link', de: 'Neuer Link' },
      href: '/new-page',
      target: '_self',
      enabled: true
    };

    onUpdate({
      links: [...(config.links || []), newLink]
    });
  };

  const updateNavigationLink = (index, updates) => {
    const updatedLinks = [...(config.links || [])];
    updatedLinks[index] = { ...updatedLinks[index], ...updates };
    onUpdate({ links: updatedLinks });
  };

  const removeNavigationLink = (index) => {
    const updatedLinks = [...(config.links || [])];
    updatedLinks.splice(index, 1);
    onUpdate({ links: updatedLinks });
  };

  const languages = ['en', 'de']; // Add more languages as needed

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-6">
        {t('admin.ui.header.title', 'Header Configuration')}
      </h3>

      <div className="space-y-6">
        {/* Header Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.ui.header.color', 'Header Color')}
          </label>
          <div className="flex items-center space-x-3">
            <div className="relative">
              <button
                onClick={() => setColorPickerOpen(!colorPickerOpen)}
                className="w-10 h-10 rounded-md border-2 border-gray-300 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={{ backgroundColor: config.defaultColor || '#4f46e5' }}
              />
              {colorPickerOpen && (
                <div className="absolute z-10 mt-2 bg-white border border-gray-200 rounded-lg shadow-lg p-4">
                  <div className="grid grid-cols-6 gap-2 mb-3">
                    {[
                      '#4f46e5', '#7c3aed', '#db2777', '#dc2626',
                      '#ea580c', '#d97706', '#ca8a04', '#65a30d',
                      '#16a34a', '#059669', '#0891b2', '#0284c7',
                      '#2563eb', '#4338ca', '#6366f1', '#8b5cf6',
                      '#a855f7', '#c026d3', '#e11d48', '#f43f5e'
                    ].map(color => (
                      <button
                        key={color}
                        onClick={() => {
                          handleColorChange(color);
                          setColorPickerOpen(false);
                        }}
                        className="w-8 h-8 rounded-md border border-gray-300 hover:scale-110 transition-transform"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <input
                    type="text"
                    value={config.defaultColor || ''}
                    onChange={(e) => handleColorChange(e.target.value)}
                    placeholder="#4f46e5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                  <button
                    onClick={() => setColorPickerOpen(false)}
                    className="mt-2 w-full px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded-md hover:bg-gray-200"
                  >
                    {t('admin.ui.close', 'Close')}
                  </button>
                </div>
              )}
            </div>
            <span className="text-sm text-gray-600">
              {config.defaultColor || '#4f46e5'}
            </span>
          </div>
        </div>

        {/* Logo Configuration */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.ui.header.logoUrl', 'Logo URL')}
          </label>
          <input
            type="text"
            value={config.logo?.url || ''}
            onChange={(e) => handleLogoUrlChange(e.target.value)}
            placeholder="/logo.svg"
            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          />
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.ui.header.logoUrlHint', 'Enter the path to your logo file (e.g., /logo.svg)')}
          </p>
        </div>

        {/* Logo Alt Text */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.ui.header.logoAlt', 'Logo Alt Text')}
          </label>
          <div className="space-y-2">
            {languages.map(lang => (
              <div key={lang} className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-600 w-8">{lang.toUpperCase()}</span>
                <input
                  type="text"
                  value={config.logo?.alt?.[lang] || ''}
                  onChange={(e) => handleLogoAltChange(lang, e.target.value)}
                  placeholder={`Logo alt text (${lang})`}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Site Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.ui.header.title', 'Site Title')}
          </label>
          <div className="space-y-2">
            {languages.map(lang => (
              <div key={lang} className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-600 w-8">{lang.toUpperCase()}</span>
                <input
                  type="text"
                  value={config.title?.[lang] || ''}
                  onChange={(e) => handleTitleChange(lang, e.target.value)}
                  placeholder={`Site title (${lang})`}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Navigation Links */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <label className="block text-sm font-medium text-gray-700">
              {t('admin.ui.header.navigationLinks', 'Navigation Links')}
            </label>
            <button
              onClick={addNavigationLink}
              className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {t('admin.ui.header.addLink', 'Add Link')}
            </button>
          </div>

          <div className="space-y-4">
            {(config.links || []).map((link, index) => (
              <div key={index} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-gray-900">
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
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      {t('admin.ui.header.linkText', 'Link Text')}
                    </label>
                    {languages.map(lang => (
                      <div key={lang} className="flex items-center space-x-2 mb-1">
                        <span className="text-xs text-gray-500 w-6">{lang}</span>
                        <input
                          type="text"
                          value={link.text?.[lang] || ''}
                          onChange={(e) => updateNavigationLink(index, {
                            text: { ...link.text, [lang]: e.target.value }
                          })}
                          placeholder={`Link text (${lang})`}
                          className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                      </div>
                    ))}
                  </div>

                  {/* Link URL */}
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      {t('admin.ui.header.linkUrl', 'URL')}
                    </label>
                    <input
                      type="text"
                      value={link.href || ''}
                      onChange={(e) => updateNavigationLink(index, { href: e.target.value })}
                      placeholder="/page-url"
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                    />
                    <div className="mt-2 flex items-center space-x-4">
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={link.enabled !== false}
                          onChange={(e) => updateNavigationLink(index, { enabled: e.target.checked })}
                          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="ml-2 text-sm text-gray-600">
                          {t('admin.ui.header.linkEnabled', 'Enabled')}
                        </span>
                      </label>
                      <select
                        value={link.target || '_self'}
                        onChange={(e) => updateNavigationLink(index, { target: e.target.value })}
                        className="text-sm border border-gray-300 rounded px-2 py-1"
                      >
                        <option value="_self">{t('admin.ui.header.samePage', 'Same Page')}</option>
                        <option value="_blank">{t('admin.ui.header.newPage', 'New Page')}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {(!config.links || config.links.length === 0) && (
              <div className="text-center py-8 text-gray-500">
                <p>{t('admin.ui.header.noLinks', 'No navigation links configured')}</p>
                <p className="text-sm">{t('admin.ui.header.addFirstLink', 'Click "Add Link" to get started')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeaderCustomization;