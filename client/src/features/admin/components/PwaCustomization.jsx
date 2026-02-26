const DISPLAY_OPTIONS = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];

const ICON_FIELDS = [
  {
    key: 'icon192',
    label: '192×192 Icon',
    hint: 'Required for Android home screen. Upload via Assets tab, paste URL here.',
    required: true
  },
  {
    key: 'icon512',
    label: '512×512 Icon',
    hint: 'Required for splash screen. Should be a high-resolution version of your logo.',
    required: true
  },
  {
    key: 'iconApple',
    label: 'Apple Touch Icon',
    hint: 'Used by iOS Safari when saving to home screen (180×180 recommended).',
    required: false
  }
];

const PwaCustomization = ({ config, onUpdate, t }) => {
  const pwa = config || {};

  const handleChange = (field, value) => {
    onUpdate({ ...pwa, [field]: value });
  };

  const handleIconChange = (iconKey, value) => {
    onUpdate({
      ...pwa,
      icons: { ...(pwa.icons || {}), [iconKey]: value }
    });
  };

  return (
    <div className="p-6 space-y-8">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-1">
          {t('admin.ui.pwa.title', 'Progressive Web App (PWA)')}
        </h3>
        <p className="text-sm text-gray-500">
          {t(
            'admin.ui.pwa.subtitle',
            'Allow users to install iHub Apps on their device home screen and enable offline fallback.'
          )}
        </p>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
        <div>
          <p className="text-sm font-medium text-gray-900">
            {t('admin.ui.pwa.enable', 'Enable PWA')}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {t(
              'admin.ui.pwa.enableHint',
              'Injects web app manifest link and meta tags into all pages. Registers a service worker for offline fallback.'
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!!pwa.enabled}
          onClick={() => handleChange('enabled', !pwa.enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
            pwa.enabled ? 'bg-indigo-600' : 'bg-gray-200'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              pwa.enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* App identity */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {t('admin.ui.pwa.identity', 'App Identity')}
        </legend>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('admin.ui.pwa.name', 'App Name')}
              <span className="ml-1 text-xs font-normal text-gray-400">(max 60 chars)</span>
            </label>
            <input
              type="text"
              maxLength={60}
              value={pwa.name || ''}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="iHub Apps"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              {t('admin.ui.pwa.nameHint', 'Shown on install prompt and app list')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('admin.ui.pwa.shortName', 'Short Name')}
              <span className="ml-1 text-xs font-normal text-gray-400">(max 15 chars)</span>
            </label>
            <input
              type="text"
              maxLength={15}
              value={pwa.shortName || ''}
              onChange={e => handleChange('shortName', e.target.value)}
              placeholder="iHub"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              {t('admin.ui.pwa.shortNameHint', 'Shown under the home screen icon')}
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('admin.ui.pwa.description', 'Description')}
          </label>
          <input
            type="text"
            maxLength={300}
            value={pwa.description || ''}
            onChange={e => handleChange('description', e.target.value)}
            placeholder="AI-powered applications platform"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
      </fieldset>

      {/* Colors */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {t('admin.ui.pwa.colors', 'Colors')}
        </legend>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('admin.ui.pwa.themeColor', 'Theme Color')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={pwa.themeColor || '#003557'}
                onChange={e => handleChange('themeColor', e.target.value)}
                className="h-9 w-12 rounded border border-gray-300 cursor-pointer"
              />
              <input
                type="text"
                value={pwa.themeColor || '#003557'}
                onChange={e => handleChange('themeColor', e.target.value)}
                placeholder="#003557"
                pattern="^#[0-9a-fA-F]{6}$"
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {t('admin.ui.pwa.themeColorHint', 'Browser chrome / status bar color on Android')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('admin.ui.pwa.backgroundColor', 'Background Color')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={pwa.backgroundColor || '#ffffff'}
                onChange={e => handleChange('backgroundColor', e.target.value)}
                className="h-9 w-12 rounded border border-gray-300 cursor-pointer"
              />
              <input
                type="text"
                value={pwa.backgroundColor || '#ffffff'}
                onChange={e => handleChange('backgroundColor', e.target.value)}
                placeholder="#ffffff"
                pattern="^#[0-9a-fA-F]{6}$"
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {t(
                'admin.ui.pwa.backgroundColorHint',
                'Splash screen background before the app paints'
              )}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Display mode */}
      <fieldset>
        <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          {t('admin.ui.pwa.display', 'Display Mode')}
        </legend>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {DISPLAY_OPTIONS.map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => handleChange('display', mode)}
              className={`px-3 py-2 text-sm rounded-md border font-medium transition-colors ${
                (pwa.display || 'standalone') === mode
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-400">
          {t(
            'admin.ui.pwa.displayHint',
            '"standalone" recommended — hides browser chrome for an app-like experience'
          )}
        </p>
      </fieldset>

      {/* Icons */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {t('admin.ui.pwa.icons', 'Icons')}
        </legend>
        <p className="text-sm text-gray-500">
          {t(
            'admin.ui.pwa.iconsHint',
            'Upload PNG icons via the Assets tab, then paste the URL below. Default icons are used when left empty.'
          )}
        </p>

        {ICON_FIELDS.map(({ key, label, hint, required }) => (
          <div key={key}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {label}
              {required && (
                <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">
                  {t('admin.ui.pwa.required', 'required')}
                </span>
              )}
            </label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={pwa.icons?.[key] || ''}
                onChange={e => handleIconChange(key, e.target.value)}
                placeholder="/uploads/assets/icon-192.png"
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:ring-indigo-500 focus:border-indigo-500"
              />
              {pwa.icons?.[key] && (
                <img
                  src={pwa.icons[key]}
                  alt={`${label} preview`}
                  className="h-10 w-10 rounded border border-gray-200 object-contain bg-gray-50 flex-shrink-0"
                  onError={e => {
                    e.target.style.display = 'none';
                  }}
                />
              )}
            </div>
            <p className="mt-1 text-xs text-gray-400">{hint}</p>
          </div>
        ))}
      </fieldset>

      {/* Live manifest link when enabled */}
      {pwa.enabled && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
          <p className="font-medium mb-1">{t('admin.ui.pwa.liveNote', 'PWA is active')}</p>
          <p>
            {t('admin.ui.pwa.manifestNote', 'Manifest is live at')}{' '}
            <a
              href="/manifest.json"
              target="_blank"
              rel="noreferrer"
              className="font-mono underline"
            >
              /manifest.json
            </a>
            {'. '}
            {t(
              'admin.ui.pwa.swNote',
              'Service worker is registered at /sw.js using a network-first strategy.'
            )}
          </p>
        </div>
      )}
    </div>
  );
};

export default PwaCustomization;
