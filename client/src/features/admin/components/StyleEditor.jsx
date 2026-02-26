import { useState } from 'react';

// Validate hex color format (#fff or #ffffff)
const isValidHexColor = color => {
  if (!color || typeof color !== 'string') return true; // Allow empty
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
};

const StyleEditor = ({ config, onUpdate, t }) => {
  const [activeSection, setActiveSection] = useState('theme');
  const [colorErrors, setColorErrors] = useState({});

  // Handle theme color changes at the root theme level
  const handleThemeColorChange = (colorKey, color, isDarkMode = false) => {
    const errorKey = isDarkMode ? `dark-${colorKey}` : colorKey;

    // Validate color format
    if (color && !isValidHexColor(color)) {
      setColorErrors(prev => ({ ...prev, [errorKey]: true }));
    } else {
      setColorErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[errorKey];
        return newErrors;
      });
    }

    const updatedConfig = { ...config };
    if (!updatedConfig.theme) {
      updatedConfig.theme = {};
    }

    if (isDarkMode) {
      if (!updatedConfig.theme.darkMode) {
        updatedConfig.theme.darkMode = {};
      }
      updatedConfig.theme.darkMode[colorKey] = color;
    } else {
      updatedConfig.theme[colorKey] = color;
    }

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

  // Theme colors configuration with proper key mappings
  const themeColors = [
    {
      key: 'primaryColor',
      label: t('theme.primaryColor', 'Primary Color'),
      hint: t('theme.primaryColorHint', 'Main brand color used for buttons, links, and accents'),
      default: '#4f46e5'
    },
    {
      key: 'primaryDark',
      label: t('theme.primaryDark', 'Primary Dark'),
      hint: t('theme.primaryDarkHint', 'Darker variant for hover states and emphasis'),
      default: '#4338ca'
    },
    {
      key: 'accentColor',
      label: t('theme.accentColor', 'Accent Color'),
      hint: t('theme.accentColorHint', 'Secondary highlight color for success states and CTAs'),
      default: '#10b981'
    },
    {
      key: 'backgroundColor',
      label: t('theme.backgroundColor', 'Background Color'),
      hint: t('theme.backgroundColorHint', 'Page background color'),
      default: '#f5f7f8'
    },
    {
      key: 'surfaceColor',
      label: t('theme.surfaceColor', 'Surface Color'),
      hint: t('theme.surfaceColorHint', 'Card and panel background color'),
      default: '#ffffff'
    },
    {
      key: 'textColor',
      label: t('theme.textColor', 'Text Color'),
      hint: t('theme.textColorHint', 'Primary text color'),
      default: '#1a1a2e'
    },
    {
      key: 'textMutedColor',
      label: t('theme.textMutedColor', 'Muted Text Color'),
      hint: t('theme.textMutedColorHint', 'Secondary/helper text color'),
      default: '#6b7280'
    }
  ];

  // Dark mode specific colors
  const darkModeColors = [
    {
      key: 'primaryColor',
      label: t('theme.primaryColor', 'Primary Color'),
      default: '#4f46e5'
    },
    {
      key: 'backgroundColor',
      label: t('theme.backgroundColor', 'Background Color'),
      default: '#1a1a2e'
    },
    {
      key: 'surfaceColor',
      label: t('theme.surfaceColor', 'Surface Color'),
      default: '#16213e'
    },
    {
      key: 'textColor',
      label: t('theme.textColor', 'Text Color'),
      default: '#f5f5f5'
    },
    {
      key: 'textMutedColor',
      label: t('theme.textMutedColor', 'Muted Text Color'),
      default: '#a0a0a0'
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
            { id: 'theme', label: t('theme.title', 'Theme & Appearance'), icon: '🎨' },
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

      {/* Theme Colors Section */}
      {activeSection === 'theme' && (
        <div className="space-y-8">
          <p className="text-sm text-gray-600">
            {t('theme.description', 'Configure brand colors, dark mode, and visual appearance')}
          </p>

          {/* Light Mode Colors */}
          <div>
            <h4 className="text-md font-medium text-gray-900 mb-4">
              {t('admin.ui.styles.lightModeColors', 'Light Mode Colors')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {themeColors.map(({ key, label, hint, default: defaultColor }) => {
                const currentColor = config.theme?.[key] || defaultColor;

                return (
                  <div key={key} className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">{label}</label>
                    {hint && <p className="text-xs text-gray-500">{hint}</p>}

                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={currentColor}
                        onChange={e => handleThemeColorChange(key, e.target.value)}
                        className="w-10 h-10 rounded-md border-2 border-gray-300 shadow-sm cursor-pointer"
                      />
                      <input
                        type="text"
                        value={currentColor}
                        onChange={e => handleThemeColorChange(key, e.target.value)}
                        className={`flex-1 px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm ${
                          colorErrors[key] ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder={defaultColor}
                      />
                    </div>
                    {colorErrors[key] && (
                      <p className="text-xs text-red-500 mt-1">
                        {t('theme.colorInvalid', 'Please enter a valid hex color (e.g., #4f46e5)')}
                      </p>
                    )}

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
          </div>

          {/* Dark Mode Colors */}
          <div className="border-t border-gray-200 pt-6">
            <h4 className="text-md font-medium text-gray-900 mb-2">
              {t('theme.darkModeSection', 'Dark Mode Colors')}
            </h4>
            <p className="text-xs text-gray-500 mb-4">
              {t(
                'theme.darkModeSectionHint',
                'Override colors for dark mode. Leave empty to use light mode values.'
              )}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {darkModeColors.map(({ key, label, default: defaultColor }) => {
                const currentColor = config.theme?.darkMode?.[key] || '';
                const errorKey = `dark-${key}`;

                return (
                  <div key={`dark-${key}`} className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">{label}</label>

                    <div className="flex items-center space-x-3">
                      <input
                        type="color"
                        value={currentColor || defaultColor}
                        onChange={e => handleThemeColorChange(key, e.target.value, true)}
                        className="w-10 h-10 rounded-md border-2 border-gray-300 shadow-sm cursor-pointer"
                      />
                      <input
                        type="text"
                        value={currentColor}
                        onChange={e => handleThemeColorChange(key, e.target.value, true)}
                        className={`flex-1 px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm ${
                          colorErrors[errorKey] ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder={defaultColor}
                      />
                    </div>
                    {colorErrors[errorKey] && (
                      <p className="text-xs text-red-500 mt-1">
                        {t('theme.colorInvalid', 'Please enter a valid hex color (e.g., #4f46e5)')}
                      </p>
                    )}

                    {/* Color Presets */}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {colorPresets.map(color => (
                        <button
                          key={color}
                          onClick={() => handleThemeColorChange(key, color, true)}
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
          </div>

          {/* Theme Preview */}
          <div className="border-t border-gray-200 pt-6">
            <h4 className="text-md font-medium text-gray-900 mb-4">
              {t('theme.preview', 'Preview')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Light Mode Preview */}
              <div
                className="p-4 rounded-lg shadow-sm border"
                style={{
                  backgroundColor: config.theme?.surfaceColor || '#ffffff',
                  color: config.theme?.textColor || '#1a1a2e'
                }}
              >
                <p className="text-xs font-medium mb-3 opacity-60">Light Mode</p>
                <div
                  className="px-4 py-2 rounded-md text-white text-sm font-medium mb-2 text-center"
                  style={{ backgroundColor: config.theme?.primaryColor || '#4f46e5' }}
                >
                  Primary Button
                </div>
                <div
                  className="px-4 py-2 rounded-md text-white text-sm font-medium mb-3 text-center"
                  style={{ backgroundColor: config.theme?.accentColor || '#10b981' }}
                >
                  Accent Button
                </div>
                <p className="text-sm" style={{ color: config.theme?.textMutedColor || '#6b7280' }}>
                  This is muted text.
                </p>
              </div>

              {/* Dark Mode Preview */}
              <div
                className="p-4 rounded-lg shadow-sm border"
                style={{
                  backgroundColor: config.theme?.darkMode?.surfaceColor || '#16213e',
                  color: config.theme?.darkMode?.textColor || '#f5f5f5'
                }}
              >
                <p className="text-xs font-medium mb-3 opacity-60">Dark Mode</p>
                <div
                  className="px-4 py-2 rounded-md text-white text-sm font-medium mb-2 text-center"
                  style={{
                    backgroundColor:
                      config.theme?.darkMode?.primaryColor ||
                      config.theme?.primaryColor ||
                      '#4f46e5'
                  }}
                >
                  Primary Button
                </div>
                <div
                  className="px-4 py-2 rounded-md text-white text-sm font-medium mb-3 text-center"
                  style={{
                    backgroundColor:
                      config.theme?.darkMode?.accentColor || config.theme?.accentColor || '#10b981'
                  }}
                >
                  Accent Button
                </div>
                <p
                  className="text-sm"
                  style={{
                    color: config.theme?.darkMode?.textMutedColor || '#a0a0a0'
                  }}
                >
                  This is muted text.
                </p>
              </div>
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
