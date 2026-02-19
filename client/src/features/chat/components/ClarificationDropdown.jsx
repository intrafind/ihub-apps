import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Dropdown selector component for clarification questions
 * Used for displaying more than 4 options in a searchable dropdown
 *
 * Features:
 * - Searchable/filterable options
 * - Single or multi-select mode with checkboxes
 * - Keyboard navigation (arrow keys, Enter to select, Escape to close)
 * - Accessible with ARIA attributes
 *
 * @param {Object} props - Component properties
 * @param {Array<{label: string, value: string, description?: string}>} props.options - Available options
 * @param {boolean} props.multiSelect - Whether multiple options can be selected
 * @param {boolean} props.allowOther - Whether to show an "Other" option for custom input
 * @param {string|string[]} props.value - Current selected value(s)
 * @param {function} props.onChange - Callback when selection changes
 * @param {string} props.placeholder - Placeholder text for the dropdown
 * @param {boolean} props.disabled - Whether the dropdown is disabled
 * @returns {JSX.Element} The ClarificationDropdown component
 */
const ClarificationDropdown = ({
  options = [],
  multiSelect = false,
  allowOther = false,
  value,
  onChange,
  placeholder,
  disabled = false
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');

  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const otherInputRef = useRef(null);

  // Normalize value to array for consistent handling
  const selectedValues = useMemo(() => {
    return Array.isArray(value) ? value : value ? [value] : [];
  }, [value]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    return options.filter(
      option =>
        option.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (option.description && option.description.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [options, searchQuery]);

  // All items including "Other" if enabled
  const displayedItems = useMemo(() => {
    return allowOther && !searchQuery
      ? [...filteredOptions, { value: '__other__', label: t('clarification.other', 'Other') }]
      : filteredOptions;
  }, [allowOther, searchQuery, filteredOptions, t]);

  /**
   * Get display text for the dropdown button
   * @returns {string} Display text showing selected values
   */
  const getDisplayText = useCallback(() => {
    if (selectedValues.length === 0) {
      return placeholder || t('clarification.selectOption', 'Select an option');
    }

    if (selectedValues.length === 1) {
      const option = options.find(o => o.value === selectedValues[0]);
      return option ? option.label : selectedValues[0];
    }

    return t('clarification.itemsSelected', '{{count}} items selected', {
      count: selectedValues.length
    });
  }, [selectedValues, options, placeholder, t]);

  /**
   * Check if a value is currently selected
   * @param {string} itemValue - The value to check
   * @returns {boolean} Whether the value is selected
   */
  const isSelected = useCallback(
    itemValue => {
      return selectedValues.includes(itemValue);
    },
    [selectedValues]
  );

  /**
   * Handle option selection/deselection
   * @param {string} itemValue - The value of the selected option
   */
  const handleSelect = useCallback(
    itemValue => {
      if (disabled) return;

      if (itemValue === '__other__') {
        setShowOtherInput(true);
        setIsOpen(false);
        setTimeout(() => otherInputRef.current?.focus(), 0);
        return;
      }

      if (multiSelect) {
        const newValues = isSelected(itemValue)
          ? selectedValues.filter(v => v !== itemValue)
          : [...selectedValues, itemValue];
        onChange(newValues);
      } else {
        onChange(itemValue);
        setIsOpen(false);
        setSearchQuery('');
      }
    },
    [disabled, multiSelect, isSelected, selectedValues, onChange]
  );

  /**
   * Handle keyboard navigation
   * @param {KeyboardEvent} e - The keyboard event
   */
  const handleKeyDown = useCallback(
    e => {
      if (disabled) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
          } else {
            setFocusedIndex(prev => Math.min(prev + 1, displayedItems.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (isOpen) {
            setFocusedIndex(prev => Math.max(prev - 1, 0));
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (isOpen && focusedIndex >= 0 && focusedIndex < displayedItems.length) {
            handleSelect(displayedItems[focusedIndex].value);
          } else if (!isOpen) {
            setIsOpen(true);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          setSearchQuery('');
          break;
        case 'Home':
          if (isOpen) {
            e.preventDefault();
            setFocusedIndex(0);
          }
          break;
        case 'End':
          if (isOpen) {
            e.preventDefault();
            setFocusedIndex(displayedItems.length - 1);
          }
          break;
        default:
          break;
      }
    },
    [disabled, isOpen, focusedIndex, displayedItems, handleSelect]
  );

  /**
   * Handle "Other" input submission
   */
  const handleOtherSubmit = useCallback(() => {
    if (otherValue.trim()) {
      if (multiSelect) {
        // Remove any previous custom values and add the new one
        const standardValues = selectedValues.filter(v => options.find(o => o.value === v));
        onChange([...standardValues, otherValue.trim()]);
      } else {
        onChange(otherValue.trim());
      }
      setShowOtherInput(false);
      setOtherValue('');
    }
  }, [otherValue, multiSelect, selectedValues, options, onChange]);

  /**
   * Handle "Other" input key events
   * @param {KeyboardEvent} e - The keyboard event
   */
  const handleOtherKeyDown = useCallback(
    e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleOtherSubmit();
      } else if (e.key === 'Escape') {
        setShowOtherInput(false);
        setOtherValue('');
      }
    },
    [handleOtherSubmit]
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Scroll focused item into view
  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.children;
      if (items[focusedIndex]) {
        items[focusedIndex].scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      }
    }
  }, [isOpen, focusedIndex]);

  // Reset focused index when search query changes
  useEffect(() => {
    setFocusedIndex(displayedItems.length > 0 ? 0 : -1);
  }, [searchQuery, displayedItems.length]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Dropdown trigger button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={getDisplayText()}
        className={`
          w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg text-sm
          border transition-colors min-h-[44px]
          focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500
          ${
            disabled
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200 dark:bg-gray-700 dark:text-gray-500 dark:border-gray-600'
              : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
          }
        `}
      >
        <span className={`truncate ${selectedValues.length === 0 ? 'text-gray-400' : ''}`}>
          {getDisplayText()}
        </span>
        <Icon
          name={isOpen ? 'chevron-up' : 'chevron-down'}
          size="sm"
          className="flex-shrink-0 text-gray-400"
        />
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg"
          role="listbox"
          aria-multiselectable={multiSelect}
        >
          {/* Search input */}
          <div className="p-2 border-b border-gray-100 dark:border-gray-700">
            <div className="relative">
              <Icon
                name="search"
                size="sm"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('clarification.searchOptions', 'Search options...')}
                className={`
                  w-full pl-9 pr-3 py-2 text-sm border rounded-md
                  focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500
                  dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100
                `}
                aria-label={t('clarification.searchOptions', 'Search options...')}
              />
            </div>
          </div>

          {/* Options list */}
          <ul ref={listRef} className="max-h-60 overflow-y-auto py-1" role="presentation">
            {displayedItems.length === 0 ? (
              <li className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 text-center">
                {t('clarification.noOptionsFound', 'No options found')}
              </li>
            ) : (
              displayedItems.map((item, index) => {
                const selected = isSelected(item.value);
                const focused = index === focusedIndex;

                return (
                  <li
                    key={item.value}
                    role="option"
                    aria-selected={selected}
                    onClick={() => handleSelect(item.value)}
                    onMouseEnter={() => setFocusedIndex(index)}
                    className={`
                      flex items-start gap-3 px-4 py-2.5 cursor-pointer
                      transition-colors min-h-[44px]
                      ${
                        focused
                          ? 'bg-indigo-50 dark:bg-indigo-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }
                    `}
                  >
                    {/* Checkbox for multi-select */}
                    {multiSelect && (
                      <div
                        className={`
                          flex-shrink-0 w-5 h-5 mt-0.5 rounded border-2 flex items-center justify-center
                          ${
                            selected
                              ? 'bg-indigo-600 border-indigo-600 dark:bg-indigo-500 dark:border-indigo-500'
                              : 'border-gray-300 dark:border-gray-600'
                          }
                        `}
                      >
                        {selected && <Icon name="check" size="xs" className="text-white" />}
                      </div>
                    )}

                    {/* Option content */}
                    <div className="flex-1 min-w-0">
                      <div
                        className={`
                          text-sm font-medium
                          ${
                            selected && !multiSelect
                              ? 'text-indigo-600 dark:text-indigo-400'
                              : 'text-gray-900 dark:text-gray-100'
                          }
                        `}
                      >
                        {item.label}
                      </div>
                      {item.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {item.description}
                        </div>
                      )}
                    </div>

                    {/* Check mark for single select */}
                    {!multiSelect && selected && (
                      <Icon
                        name="check"
                        size="sm"
                        className="flex-shrink-0 text-indigo-600 dark:text-indigo-400 mt-0.5"
                      />
                    )}
                  </li>
                );
              })
            )}
          </ul>

          {/* Selected count for multi-select */}
          {multiSelect && selectedValues.length > 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700">
              {t('clarification.selectedCount', '{{count}} selected', {
                count: selectedValues.length
              })}
            </div>
          )}
        </div>
      )}

      {/* "Other" input field */}
      {allowOther && showOtherInput && (
        <div className="flex items-center gap-2 mt-2">
          <input
            ref={otherInputRef}
            type="text"
            value={otherValue}
            onChange={e => setOtherValue(e.target.value)}
            onKeyDown={handleOtherKeyDown}
            placeholder={t('clarification.enterCustomValue', 'Enter your answer...')}
            disabled={disabled}
            className={`
              flex-1 px-3 py-2 border rounded-lg text-sm
              focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500
              dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100
              ${disabled ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'}
            `}
            aria-label={t('clarification.customAnswer', 'Custom answer')}
          />
          <button
            type="button"
            onClick={handleOtherSubmit}
            disabled={disabled || !otherValue.trim()}
            className={`
              p-2 rounded-lg transition-colors
              ${
                disabled || !otherValue.trim()
                  ? 'text-gray-400 cursor-not-allowed'
                  : 'text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/20'
              }
            `}
            aria-label={t('common.confirm', 'Confirm')}
          >
            <Icon name="check" size="sm" />
          </button>
          <button
            type="button"
            onClick={() => {
              setShowOtherInput(false);
              setOtherValue('');
            }}
            disabled={disabled}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('common.cancel', 'Cancel')}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
    </div>
  );
};

export default ClarificationDropdown;
