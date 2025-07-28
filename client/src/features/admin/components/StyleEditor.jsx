import { useState } from 'react';

const StyleEditor = ({ config, onUpdate, t }) => {
  const [activeSection, setActiveSection] = useState('css');

  const handleThemeColorChange = (colorKey, color) => {
    const updatedConfig = {
      ...config,
      theme: {
        ...config.theme,
        colors: {
          ...config.theme?.colors,
          [colorKey]: color
        }
      }
    };
    onUpdate(updatedConfig);
  };

  const handleCustomCssChange = css => {
    const updatedConfig = {
      ...config,
      customStyles: {
        ...config.customStyles,
        css: css
      }
    };
    onUpdate(updatedConfig);
  };

  const addCssVariable = () => {
    const name = prompt(
      t('admin.ui.styles.addVariableName', 'Enter CSS variable name (without --):')
    );
    if (!name) return;

    const value = prompt(t('admin.ui.styles.addVariableValue', 'Enter CSS variable value:'));
    if (!value) return;

    const updatedConfig = {
      ...config,
      theme: {
        ...config.theme,
        cssVariables: {
          ...config.theme?.cssVariables,
          [name]: value
        }
      }
    };
    onUpdate(updatedConfig);
  };

  const updateCssVariable = (name, value) => {
    const updatedConfig = {
      ...config,
      theme: {
        ...config.theme,
        cssVariables: {
          ...config.theme?.cssVariables,
          [name]: value
        }
      }
    };
    onUpdate(updatedConfig);
  };

  const removeCssVariable = name => {
    const updatedConfig = { ...config };
    if (updatedConfig.theme?.cssVariables) {
      delete updatedConfig.theme.cssVariables[name];
    }
    onUpdate(updatedConfig);
  };

  const themeColors = [
    {
      key: 'primary',
      label: t('admin.ui.styles.primaryColor', 'Primary Color'),
      default: '#4f46e5'
    },
    {
      key: 'secondary',
      label: t('admin.ui.styles.secondaryColor', 'Secondary Color'),
      default: '#6b7280'
    },
    { key: 'accent', label: t('admin.ui.styles.accentColor', 'Accent Color'), default: '#10b981' },
    {
      key: 'background',
      label: t('admin.ui.styles.backgroundColor', 'Background Color'),
      default: '#ffffff'
    },
    {
      key: 'surface',
      label: t('admin.ui.styles.surfaceColor', 'Surface Color'),
      default: '#f9fafb'
    },
    { key: 'text', label: t('admin.ui.styles.textColor', 'Text Color'), default: '#111827' },
    {
      key: 'textMuted',
      label: t('admin.ui.styles.textMutedColor', 'Muted Text Color'),
      default: '#6b7280'
    }
  ];

  const colorPresets = [
    '#4f46e5',
    '#7c3aed',
    '#db2777',
    '#dc2626',
    '#ea580c',
    '#d97706',
    '#ca8a04',
    '#65a30d',
    '#16a34a',
    '#059669',
    '#0891b2',
    '#0284c7',
    '#2563eb',
    '#4338ca',
    '#6366f1',
    '#8b5cf6',
    '#a855f7',
    '#c026d3',
    '#e11d48',
    '#f43f5e'
  ];

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-6">
        {t('admin.ui.styles.title', 'Style Configuration')}
      </h3>

      {/* Section Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex space-x-8" aria-label="Tabs">
          {[
            // { id: 'theme', label: t('admin.ui.styles.themeColors', 'Theme Colors'), icon: '🎨' },
            { id: 'css', label: t('admin.ui.styles.customCss', 'Custom CSS'), icon: '⚙️' },
            {
              id: 'variables',
              label: t('admin.ui.styles.cssVariables', 'CSS Variables'),
              icon: '🔧'
            }
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

      {/* Theme Colors Section - Hidden for now */}
      {false && activeSection === 'theme' && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            {t(
              'admin.ui.styles.themeDescription',
              'Configure the main theme colors used throughout the application.'
            )}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {themeColors.map(({ key, label, default: defaultColor }) => {
              const currentColor = config.theme?.colors?.[key] || defaultColor;

              return (
                <div key={key} className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">{label}</label>

                  <div className="flex items-center space-x-3">
                    <div
                      className="w-10 h-10 rounded-md border-2 border-gray-300 shadow-sm cursor-pointer"
                      style={{ backgroundColor: currentColor }}
                    />

                    <input
                      type="text"
                      value={currentColor}
                      onChange={e => handleThemeColorChange(key, e.target.value)}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder={defaultColor}
                    />
                  </div>

                  {/* Color Presets */}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {colorPresets.map(color => (
                      <button
                        key={color}
                        onClick={() => handleThemeColorChange(key, color)}
                        className="w-6 h-6 rounded border border-gray-300 hover:scale-110 transition-transform"
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md">
            <h4 className="text-sm font-medium text-blue-900 mb-2">
              {t('admin.ui.styles.preview', 'Theme Preview')}
            </h4>
            <div
              className="p-4 rounded-md shadow-sm"
              style={{
                backgroundColor: config.theme?.colors?.surface || '#f9fafb',
                color: config.theme?.colors?.text || '#111827'
              }}
            >
              <div
                className="px-4 py-2 rounded-md text-white mb-2"
                style={{ backgroundColor: config.theme?.colors?.primary || '#4f46e5' }}
              >
                {t('admin.ui.styles.primaryButton', 'Primary Button')}
              </div>
              <div
                className="px-4 py-2 rounded-md text-white"
                style={{ backgroundColor: config.theme?.colors?.accent || '#10b981' }}
              >
                {t('admin.ui.styles.accentButton', 'Accent Button')}
              </div>
              <p className="mt-3" style={{ color: config.theme?.colors?.textMuted || '#6b7280' }}>
                {t(
                  'admin.ui.styles.sampleText',
                  'This is sample muted text to preview the theme colors.'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Custom CSS Section */}
      {activeSection === 'css' && (
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-md font-medium text-gray-900">
                {t('admin.ui.styles.customCssTitle', 'Custom CSS')}
              </h4>
              <p className="text-sm text-gray-600">
                {t(
                  'admin.ui.styles.customCssDescription',
                  'Add custom CSS that will be injected into the page head.'
                )}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <textarea
              value={config.customStyles?.css || ''}
              onChange={e => handleCustomCssChange(e.target.value)}
              placeholder={`/* Enter your custom CSS here */
.custom-header {
  background: linear-gradient(45deg, #4f46e5, #7c3aed);
}

.custom-button {
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}`}
              rows={15}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
            />

            <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
              <div className="flex">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-yellow-800">
                    {t('admin.ui.styles.warning', 'Warning')}
                  </h3>
                  <div className="mt-2 text-sm text-yellow-700">
                    <p>
                      {t(
                        'admin.ui.styles.cssWarning',
                        'Custom CSS can affect the entire application. Test changes carefully and always backup your configuration before making significant changes.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CSS Variables Section */}
      {activeSection === 'variables' && (
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-md font-medium text-gray-900">
                {t('admin.ui.styles.cssVariablesTitle', 'CSS Variables')}
              </h4>
              <p className="text-sm text-gray-600">
                {t(
                  'admin.ui.styles.cssVariablesDescription',
                  'Define CSS custom properties that can be used in your custom CSS.'
                )}
              </p>
            </div>
            <button
              onClick={addCssVariable}
              className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {t('admin.ui.styles.addVariable', 'Add Variable')}
            </button>
          </div>

          <div className="space-y-3">
            {config.theme?.cssVariables ? (
              Object.entries(config.theme.cssVariables).map(([name, value]) => (
                <div key={name} className="flex items-center space-x-3 p-3 bg-gray-50 rounded-md">
                  <code className="text-sm font-mono text-gray-900">--{name}:</code>
                  <input
                    type="text"
                    value={value}
                    onChange={e => updateCssVariable(name, e.target.value)}
                    className="flex-1 px-3 py-1 border border-gray-300 rounded text-sm"
                  />
                  <button
                    onClick={() => removeCssVariable(name)}
                    className="text-red-600 hover:text-red-800 p-1"
                    title={t('admin.ui.remove', 'Remove')}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-gray-500">
                <p>{t('admin.ui.styles.noVariables', 'No CSS variables defined')}</p>
                <p className="text-sm">
                  {t('admin.ui.styles.addFirstVariable', 'Click "Add Variable" to get started')}
                </p>
              </div>
            )}
          </div>

          {config.theme?.cssVariables && Object.keys(config.theme.cssVariables).length > 0 && (
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-md">
              <h5 className="text-sm font-medium text-blue-900 mb-2">
                {t('admin.ui.styles.generatedCss', 'Generated CSS')}
              </h5>
              <pre className="text-xs text-blue-800 whitespace-pre-wrap font-mono">
                {`:root {\n${Object.entries(config.theme.cssVariables)
                  .map(([name, value]) => `  --${name}: ${value};`)
                  .join('\n')}\n}`}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StyleEditor;
