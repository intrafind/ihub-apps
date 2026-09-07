const SANDBOX_PERMISSIONS = [
  {
    value: 'allow-scripts',
    labelKey: 'admin.apps.edit.allowScripts',
    labelDefault: 'Allow Scripts (required for most interactive content)'
  },
  {
    value: 'allow-same-origin',
    labelKey: 'admin.apps.edit.allowSameOrigin',
    labelDefault: 'Allow Same Origin (enables localStorage, cookies)'
  },
  {
    value: 'allow-forms',
    labelKey: 'admin.apps.edit.allowForms',
    labelDefault: 'Allow Forms (enable form submission)'
  },
  {
    value: 'allow-popups',
    labelKey: 'admin.apps.edit.allowPopups',
    labelDefault: 'Allow Popups'
  },
  {
    value: 'allow-modals',
    labelKey: 'admin.apps.edit.allowModals',
    labelDefault: 'Allow Modals (alert, confirm, etc.)'
  },
  {
    value: 'allow-top-navigation',
    labelKey: 'admin.apps.edit.allowTopNavigation',
    labelDefault: 'Allow Top Navigation (navigate parent window)'
  }
];

const DEFAULT_SANDBOX = ['allow-scripts', 'allow-same-origin', 'allow-forms'];

/**
 * Iframe Configuration card — only rendered for apps with type 'iframe'.
 */
function IframeConfigSection({ app, onChange, t }) {
  const currentSandbox = app.iframeConfig?.sandbox || (app.iframeConfig ? [] : DEFAULT_SANDBOX);

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.iframeConfig', 'Iframe Configuration')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.iframeConfigDesc', 'Configure the embedded iframe content')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.iframeUrl', 'Iframe URL')}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <input
                type="url"
                value={app.iframeConfig?.url || ''}
                onChange={e =>
                  onChange('iframeConfig', {
                    ...app.iframeConfig,
                    url: e.target.value
                  })
                }
                placeholder="https://example.com"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.iframeConfig?.allowFullscreen !== false}
                onChange={e =>
                  onChange('iframeConfig', {
                    ...app.iframeConfig,
                    allowFullscreen: e.target.checked
                  })
                }
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.allowFullscreen', 'Allow Fullscreen')}
              </label>
            </div>

            {/* Sandbox Configuration */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.apps.edit.sandboxPermissions', 'Sandbox Permissions')}
              </label>
              <p className="text-xs text-gray-500 mb-3">
                {t(
                  'admin.apps.edit.sandboxPermissionsDesc',
                  'Control what the embedded content is allowed to do. Uncheck options to restrict permissions for better security.'
                )}
              </p>
              <div className="space-y-2 pl-4">
                {SANDBOX_PERMISSIONS.map(permission => {
                  const isChecked = currentSandbox.includes(permission.value);

                  return (
                    <div key={permission.value} className="flex items-center">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={e => {
                          const previousSandbox = app.iframeConfig?.sandbox || DEFAULT_SANDBOX;
                          const newSandbox = e.target.checked
                            ? [...previousSandbox, permission.value]
                            : previousSandbox.filter(p => p !== permission.value);

                          onChange('iframeConfig', {
                            ...app.iframeConfig,
                            sandbox: newSandbox
                          });
                        }}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-700">
                        {t(permission.labelKey, permission.labelDefault)}
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IframeConfigSection;
