import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Chip-based selector component for clarification questions
 * Used for displaying 4 or fewer options as selectable chips
 *
 * Features:
 * - Single or multi-select mode
 * - Keyboard navigation (arrow keys, Enter/Space to select)
 * - Visual feedback with checkmarks for selected items
 * - Optional "Other" option for custom input
 *
 * @param {Object} props - Component properties
 * @param {Array<{label: string, value: string, description?: string}>} props.options - Available options
 * @param {boolean} props.multiSelect - Whether multiple options can be selected
 * @param {boolean} props.allowOther - Whether to show an "Other" option for custom input
 * @param {string|string[]} props.value - Current selected value(s)
 * @param {function} props.onChange - Callback when selection changes
 * @param {boolean} props.disabled - Whether the chips are disabled
 * @returns {JSX.Element} The ClarificationChips component
 */
const ClarificationChips = ({
  options = [],
  multiSelect = false,
  allowOther = false,
  value,
  onChange,
  disabled = false
}) => {
  const { t } = useTranslation();
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const containerRef = useRef(null);
  const otherInputRef = useRef(null);

  // Normalize value to array for consistent handling
  const selectedValues = useMemo(() => {
    return Array.isArray(value) ? value : value ? [value] : [];
  }, [value]);

  // All selectable items including "Other" if enabled
  const allItems = useMemo(() => {
    return allowOther
      ? [...options, { value: '__other__', label: t('clarification.other', 'Other') }]
      : options;
  }, [allowOther, options, t]);

  /**
   * Check if a value is currently selected
   * @param {string} itemValue - The value to check
   * @returns {boolean} Whether the value is selected
   */
  const isSelected = useCallback(
    itemValue => {
      if (itemValue === '__other__') {
        return showOtherInput || selectedValues.some(v => !options.find(o => o.value === v));
      }
      return selectedValues.includes(itemValue);
    },
    [selectedValues, showOtherInput, options]
  );

  /**
   * Handle chip selection/deselection
   * @param {string} itemValue - The value of the clicked chip
   */
  const handleSelect = useCallback(
    itemValue => {
      if (disabled) return;

      if (itemValue === '__other__') {
        setShowOtherInput(true);
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
        setShowOtherInput(false);
      }
    },
    [disabled, multiSelect, isSelected, selectedValues, onChange]
  );

  /**
   * Handle keyboard navigation within the chip group
   * @param {KeyboardEvent} e - The keyboard event
   */
  const handleKeyDown = useCallback(
    e => {
      if (disabled) return;

      const itemCount = allItems.length;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex(prev => (prev + 1) % itemCount);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex(prev => (prev - 1 + itemCount) % itemCount);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < allItems.length) {
            handleSelect(allItems[focusedIndex].value);
          }
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(itemCount - 1);
          break;
        default:
          break;
      }
    },
    [disabled, allItems, focusedIndex, handleSelect]
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

  // Focus management
  useEffect(() => {
    if (focusedIndex >= 0 && containerRef.current) {
      const buttons = containerRef.current.querySelectorAll('[role="option"]');
      if (buttons[focusedIndex]) {
        buttons[focusedIndex].focus();
      }
    }
  }, [focusedIndex]);

  return (
    <div className="space-y-3">
      {/* Chip container */}
      <div
        ref={containerRef}
        role="listbox"
        aria-multiselectable={multiSelect}
        aria-label={t('clarification.selectOptions', 'Select options')}
        className="flex flex-wrap gap-2"
        onKeyDown={handleKeyDown}
      >
        {allItems.map((item, index) => {
          const selected = isSelected(item.value);
          const focused = index === focusedIndex;

          return (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={focused || (focusedIndex === -1 && index === 0) ? 0 : -1}
              disabled={disabled}
              onClick={() => handleSelect(item.value)}
              onFocus={() => setFocusedIndex(index)}
              className={`
                inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium
                transition-all duration-150 ease-in-out
                min-h-[44px] min-w-[44px]
                focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500
                ${
                  disabled
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
                    : selected
                      ? 'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }
              `}
            >
              {multiSelect && selected && <Icon name="check" size="sm" className="flex-shrink-0" />}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Option descriptions */}
      {options.some(o => o.description) && (
        <div className="space-y-1">
          {options
            .filter(o => isSelected(o.value) && o.description)
            .map(option => (
              <p key={option.value} className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                <span className="font-medium">{option.label}:</span> {option.description}
              </p>
            ))}
        </div>
      )}

      {/* "Other" input field */}
      {allowOther && showOtherInput && (
        <div className="flex items-center gap-2">
          <input
            ref={otherInputRef}
            type="text"
            value={otherValue}
            onChange={e => setOtherValue(e.target.value)}
            onKeyDown={handleOtherKeyDown}
            onBlur={handleOtherSubmit}
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

export default ClarificationChips;
