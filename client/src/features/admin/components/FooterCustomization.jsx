import React from 'react';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

const FooterCustomization = ({ config, onUpdate, t }) => {
  const addFooterLink = () => {
    const newLink = {
      text: { en: 'New Link' },
      href: '/new-page',
      target: '_self',
      enabled: true
    };

    onUpdate({
      links: [...(config.links || []), newLink]
    });
  };

  const updateFooterLink = (index, updates) => {
    const updatedLinks = [...(config.links || [])];
    updatedLinks[index] = { ...updatedLinks[index], ...updates };
    onUpdate({ links: updatedLinks });
  };

  const removeFooterLink = index => {
    const updatedLinks = [...(config.links || [])];
    updatedLinks.splice(index, 1);
    onUpdate({ links: updatedLinks });
  };

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-6">
        {t('admin.ui.footer.title', 'Footer Configuration')}
      </h3>

      <div className="space-y-6">
        {/* Footer Enabled */}
        <div>
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={config.enabled !== false}
              onChange={e => onUpdate({ enabled: e.target.checked })}
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
            />
            <label className="ml-2 block text-sm text-gray-900">
              {t('admin.ui.footer.enabled', 'Enable Footer')}
            </label>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.ui.footer.enabledHint', 'Uncheck to hide the footer from all pages')}
          </p>
        </div>

        {config.enabled !== false && (
          <>
            {/* Footer Text */}
            <div>
              <DynamicLanguageEditor
                label={t('admin.ui.footer.text', 'Footer Text')}
                value={config.text || {}}
                onChange={text => onUpdate({ text })}
                type="textarea"
                placeholder={{
                  en: 'Footer text (en)',
                  de: 'Footer text (de)',
                  es: 'Footer text (es)',
                  fr: 'Footer text (fr)'
                }}
              />
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.ui.footer.textHint',
                  'This text will appear in the footer. You can use basic HTML tags.'
                )}
              </p>
            </div>

            {/* Footer Links */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.ui.footer.links', 'Footer Links')}
                </label>
                <button
                  onClick={addFooterLink}
                  className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {t('admin.ui.footer.addLink', 'Add Link')}
                </button>
              </div>

              <div className="space-y-4">
                {(config.links || []).map((link, index) => (
                  <div key={index} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-gray-900">
                        {t('admin.ui.footer.link', 'Link')} {index + 1}
                      </h4>
                      <button
                        onClick={() => removeFooterLink(index)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        {t('admin.ui.remove', 'Remove')}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Link Text */}
                      <div>
                        <DynamicLanguageEditor
                          label={t('admin.ui.footer.linkText', 'Link Text')}
                          value={link.text || {}}
                          onChange={text => updateFooterLink(index, { text })}
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
                        <label className="block text-sm font-medium text-gray-600 mb-1">
                          {t('admin.ui.footer.linkUrl', 'URL')}
                        </label>
                        <input
                          type="text"
                          value={link.href || ''}
                          onChange={e => updateFooterLink(index, { href: e.target.value })}
                          placeholder="/page-url or https://external.com"
                          className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                        <div className="mt-2 flex items-center space-x-4">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={link.enabled !== false}
                              onChange={e => updateFooterLink(index, { enabled: e.target.checked })}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className="ml-2 text-sm text-gray-600">
                              {t('admin.ui.footer.linkEnabled', 'Enabled')}
                            </span>
                          </label>
                          <select
                            value={link.target || '_self'}
                            onChange={e => updateFooterLink(index, { target: e.target.value })}
                            className="text-sm border border-gray-300 rounded px-2 py-1"
                          >
                            <option value="_self">
                              {t('admin.ui.footer.samePage', 'Same Page')}
                            </option>
                            <option value="_blank">
                              {t('admin.ui.footer.newPage', 'New Page')}
                            </option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {(!config.links || config.links.length === 0) && (
                  <div className="text-center py-8 text-gray-500">
                    <p>{t('admin.ui.footer.noLinks', 'No footer links configured')}</p>
                    <p className="text-sm">
                      {t('admin.ui.footer.addFirstLink', 'Click "Add Link" to get started')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default FooterCustomization;
