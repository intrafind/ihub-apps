// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState, useRef, useEffect } from 'react';
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
 * IconPicker - A searchable icon picker component. The list opens below the
 * button; Escape and a click outside close it.
 *
 * @param {Object} props
 * @param {string} props.value - Currently selected icon name
 * @param {Function} props.onChange - Callback when icon is selected
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.error - Error message to display
 * @param {string} [props.id] - The id of the button, for a `<label htmlFor>`
 * @param {string} [props.labelledBy] - The id of the element that names the picker
 */
function IconPicker({ value, onChange, className = '', error, id, labelledBy }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);
  const triggerRef = useRef(null);
  const baseId = useId();
  const triggerId = id || `${baseId}-trigger`;
  const listId = `${baseId}-list`;

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

    let focusTimer;
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Focus search input when dropdown opens
      focusTimer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const close = () => {
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleIconSelect = iconName => {
    onChange(iconName);
    close();
    triggerRef.current?.focus();
  };

  // Escape closes the list and returns to the button; it must not reach a
  // dialog or a page shortcut behind it.
  const handleKeyDown = event => {
    if (event.key !== 'Escape' || !isOpen) return;
    event.stopPropagation();
    close();
    triggerRef.current?.focus();
  };

  return (
    // The key handler only catches Escape from the controls inside.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className={`relative ${className}`} ref={dropdownRef} onKeyDown={handleKeyDown}>
      {/* Selected Icon Display / Trigger Button */}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        className={`w-full flex items-center justify-between px-3 py-2 border rounded-md shadow-xs text-sm bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 ${
          error
            ? 'border-red-300 dark:border-red-500'
            : 'border-admin-control-border dark:border-admin-control-border-dark'
        }`}
      >
        <div className="flex min-w-0 items-center space-x-2">
          {value ? (
            <>
              <Icon name={value} size="md" className="shrink-0 text-gray-700 dark:text-gray-200" />
              <span className="truncate text-gray-900 dark:text-gray-100">{value}</span>
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">
              {t('admin.apps.edit.selectIcon', 'Select an icon')}
            </span>
          )}
        </div>
        <Icon name="chevron-down" size="sm" className="shrink-0 text-gray-500 dark:text-gray-400" />
      </button>

      {/* Error Message */}
      {error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* While the list is open it is the only thing to click. Without the
          layer below, the list half covers the controls beside the picker, and
          what is left of them is too small a target (WCAG 2.5.8); a click
          beside the list closes it instead. */}
      {isOpen && <div className="fixed inset-0 z-40" aria-hidden="true" onMouseDown={close} />}

      {/* Dropdown */}
      {isOpen && (
        <div
          id={listId}
          className="absolute z-50 mt-1 w-full sm:min-w-[24rem] bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-96 overflow-hidden"
        >
          {/* Search Input */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-700">
            <div className="relative">
              <Icon
                name="search"
                size="sm"
                className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder={t('admin.apps.edit.searchIcons', 'Search icons...')}
                aria-label={t('admin.apps.edit.searchIcons', 'Search icons...')}
                className="w-full pl-8 pr-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Icon Grid: four columns on a phone, six where there is room */}
          <div className="p-2 overflow-y-auto max-h-80">
            {filteredIcons.length > 0 ? (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-1">
                {filteredIcons.map(iconName => (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => handleIconSelect(iconName)}
                    aria-label={iconName}
                    aria-pressed={value === iconName}
                    className={`flex flex-col items-center justify-center px-1 py-2.5 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/40 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      value === iconName
                        ? 'bg-indigo-100 dark:bg-indigo-900/60 ring-2 ring-indigo-500'
                        : 'bg-gray-50 dark:bg-gray-700'
                    }`}
                    title={iconName}
                  >
                    <Icon name={iconName} size="lg" className="text-gray-700 dark:text-gray-200" />
                    <span className="mt-1 text-xs text-gray-600 dark:text-gray-300 truncate w-full text-center">
                      {iconName.split('-')[0]}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <Icon
                  name="search"
                  size="xl"
                  className="mx-auto mb-2 text-gray-500 dark:text-gray-400"
                />
                <p className="text-sm">{t('admin.apps.edit.noIconsFound', 'No icons found')}</p>
              </div>
            )}
          </div>

          {/* Footer with count */}
          <div className="p-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
            <p className="text-xs text-gray-600 dark:text-gray-300 text-center">
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
}

export default IconPicker;
