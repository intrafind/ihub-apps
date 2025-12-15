import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

// Get all available icons from the Icon component
// This list should match the iconMap in Icon.jsx
const AVAILABLE_ICONS = [
  'academic-cap',
  'arrow-right',
  'briefcase',
  'calendar',
  'camera',
  'chat',
  'chat-bubbles',
  'check',
  'check-circle',
  'chevron-down',
  'clock',
  'close',
  'code',
  'cog',
  'color-swatch',
  'copy',
  'cpu-chip',
  'document-search',
  'document-text',
  'download',
  'edit',
  'exclamation-circle',
  'exclamation-triangle',
  'external-link',
  'eye',
  'eye-slash',
  'face-frown',
  'format',
  'globe',
  'information-circle',
  'light-bulb',
  'link',
  'list',
  'login',
  'logout',
  'mail',
  'menu',
  'microphone',
  'minus-circle',
  'paint-brush',
  'paper-clip',
  'pencil',
  'play',
  'plus',
  'plus-circle',
  'question-mark-circle',
  'redo',
  'refresh',
  'save',
  'search',
  'settings',
  'share',
  'sliders',
  'sparkles',
  'star',
  'thumbs-down',
  'thumbs-up',
  'trash',
  'undo',
  'user',
  'users',
  'warning'
].sort();

/**
 * IconPicker - A searchable icon picker component
 * @param {Object} props
 * @param {string} props.value - Currently selected icon name
 * @param {Function} props.onChange - Callback when icon is selected
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.error - Error message to display
 */
const IconPicker = ({ value, onChange, className = '', error }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Filter icons based on search term
  const filteredIcons = AVAILABLE_ICONS.filter(icon =>
    icon.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Focus search input when dropdown opens
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleIconSelect = iconName => {
    onChange(iconName);
    setIsOpen(false);
    setSearchTerm('');
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Selected Icon Display / Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between px-3 py-2 border rounded-md shadow-sm text-sm bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
          error ? 'border-red-300' : 'border-gray-300'
        }`}
      >
        <div className="flex items-center space-x-2">
          {value ? (
            <>
              <Icon name={value} size="md" className="text-gray-700" />
              <span className="text-gray-900">{value}</span>
            </>
          ) : (
            <span className="text-gray-400">{t('admin.apps.edit.selectIcon', 'Select an icon')}</span>
          )}
        </div>
        <Icon name="chevron-down" size="sm" className="text-gray-400" />
      </button>

      {/* Error Message */}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-96 overflow-hidden">
          {/* Search Input */}
          <div className="p-2 border-b border-gray-200">
            <div className="relative">
              <Icon
                name="search"
                size="sm"
                className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder={t('admin.apps.edit.searchIcons', 'Search icons...')}
                className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Icon Grid */}
          <div className="p-2 overflow-y-auto max-h-80">
            {filteredIcons.length > 0 ? (
              <div className="grid grid-cols-6 gap-1">
                {filteredIcons.map(iconName => (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => handleIconSelect(iconName)}
                    className={`flex flex-col items-center justify-center p-3 rounded-md hover:bg-indigo-50 transition-colors ${
                      value === iconName ? 'bg-indigo-100 ring-2 ring-indigo-500' : 'bg-gray-50'
                    }`}
                    title={iconName}
                  >
                    <Icon name={iconName} size="lg" className="text-gray-700" />
                    <span className="mt-1 text-xs text-gray-600 truncate w-full text-center">
                      {iconName.split('-')[0]}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <Icon name="search" size="xl" className="mx-auto mb-2 text-gray-400" />
                <p className="text-sm">{t('admin.apps.edit.noIconsFound', 'No icons found')}</p>
              </div>
            )}
          </div>

          {/* Footer with count */}
          <div className="p-2 border-t border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-600 text-center">
              {filteredIcons.length === AVAILABLE_ICONS.length
                ? t('admin.apps.edit.iconCount', '{{count}} icons available', {
                    count: AVAILABLE_ICONS.length
                  })
                : t('admin.apps.edit.iconCountFiltered', '{{filtered}} of {{total}} icons', {
                    filtered: filteredIcons.length,
                    total: AVAILABLE_ICONS.length
                  })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default IconPicker;
