import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Input component for clarification questions
 * Handles text, number, date, and date_range input types
 *
 * Features:
 * - Text input with textarea for longer responses
 * - Number input with min/max validation
 * - Date picker for single dates
 * - Date range picker for start/end dates
 * - Accessible with proper labels and ARIA attributes
 *
 * @param {Object} props - Component properties
 * @param {'text'|'number'|'date'|'date_range'} props.inputType - The type of input to render
 * @param {string|number|Object} props.value - Current value (string for text, number, date; object for date_range)
 * @param {function} props.onChange - Callback when value changes
 * @param {string} props.placeholder - Placeholder text
 * @param {number} props.min - Minimum value for number input
 * @param {number} props.max - Maximum value for number input
 * @param {string} props.minDate - Minimum date for date inputs
 * @param {string} props.maxDate - Maximum date for date inputs
 * @param {boolean} props.disabled - Whether the input is disabled
 * @param {boolean} props.required - Whether the input is required
 * @returns {JSX.Element} The ClarificationInput component
 */
const ClarificationInput = ({
  inputType = 'text',
  value,
  onChange,
  placeholder,
  min,
  max,
  minDate,
  maxDate,
  disabled = false,
  required = false
}) => {
  const { t } = useTranslation();
  const textareaRef = useRef(null);
  const [validationError, setValidationError] = useState('');

  /**
   * Handle text input changes with auto-resize
   * @param {Event} e - The change event
   */
  const handleTextChange = useCallback(
    e => {
      onChange(e.target.value);
      setValidationError('');

      // Auto-resize textarea
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      }
    },
    [onChange]
  );

  /**
   * Handle number input changes with validation
   * @param {Event} e - The change event
   */
  const handleNumberChange = useCallback(
    e => {
      const numValue = e.target.value === '' ? '' : Number(e.target.value);

      // Validate min/max
      if (numValue !== '' && min !== undefined && numValue < min) {
        setValidationError(
          t('clarification.validation.minValue', 'Value must be at least {{min}}', { min })
        );
      } else if (numValue !== '' && max !== undefined && numValue > max) {
        setValidationError(
          t('clarification.validation.maxValue', 'Value must be at most {{max}}', { max })
        );
      } else {
        setValidationError('');
      }

      onChange(numValue);
    },
    [onChange, min, max, t]
  );

  /**
   * Handle date input changes
   * @param {Event} e - The change event
   */
  const handleDateChange = useCallback(
    e => {
      onChange(e.target.value);
      setValidationError('');
    },
    [onChange]
  );

  /**
   * Handle date range changes
   * @param {'start'|'end'} field - Which date field to update
   * @param {string} dateValue - The new date value
   */
  const handleDateRangeChange = useCallback(
    (field, dateValue) => {
      const currentValue = value || {};
      const newValue = { ...currentValue, [field]: dateValue };

      // Validate that start is before end
      if (newValue.start && newValue.end && newValue.start > newValue.end) {
        setValidationError(
          t('clarification.validation.dateRange', 'Start date must be before end date')
        );
      } else {
        setValidationError('');
      }

      onChange(newValue);
    },
    [value, onChange, t]
  );

  /**
   * Render text input (textarea)
   */
  const renderTextInput = () => (
    <textarea
      ref={textareaRef}
      value={value || ''}
      onChange={handleTextChange}
      placeholder={placeholder || t('clarification.textPlaceholder', 'Type your answer...')}
      disabled={disabled}
      required={required}
      rows={2}
      className={`
        w-full px-4 py-3 text-sm border rounded-lg resize-none
        transition-colors min-h-[44px]
        focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none
        dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400
        ${
          disabled
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
            : 'bg-white text-gray-900 border-gray-300'
        }
      `}
      aria-label={placeholder || t('clarification.textPlaceholder', 'Type your answer...')}
    />
  );

  /**
   * Render number input
   */
  const renderNumberInput = () => (
    <div className="relative">
      <input
        type="number"
        value={value ?? ''}
        onChange={handleNumberChange}
        placeholder={placeholder || t('clarification.numberPlaceholder', 'Enter a number...')}
        disabled={disabled}
        required={required}
        min={min}
        max={max}
        className={`
          w-full px-4 py-3 text-sm border rounded-lg
          transition-colors min-h-[44px]
          focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none
          dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400
          ${
            disabled
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
              : 'bg-white text-gray-900 border-gray-300'
          }
          ${validationError ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''}
        `}
        aria-label={placeholder || t('clarification.numberPlaceholder', 'Enter a number...')}
        aria-invalid={!!validationError}
      />
      {/* Number constraints hint */}
      {(min !== undefined || max !== undefined) && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {min !== undefined && max !== undefined
            ? t('clarification.numberRange', 'Range: {{min}} - {{max}}', { min, max })
            : min !== undefined
              ? t('clarification.numberMin', 'Minimum: {{min}}', { min })
              : t('clarification.numberMax', 'Maximum: {{max}}', { max })}
        </p>
      )}
    </div>
  );

  /**
   * Render date input
   */
  const renderDateInput = () => (
    <div className="relative">
      <div className="relative">
        <Icon
          name="calendar"
          size="sm"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
        />
        <input
          type="date"
          value={value || ''}
          onChange={handleDateChange}
          disabled={disabled}
          required={required}
          min={minDate}
          max={maxDate}
          className={`
            w-full pl-10 pr-4 py-3 text-sm border rounded-lg
            transition-colors min-h-[44px]
            focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none
            dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100
            ${
              disabled
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
                : 'bg-white text-gray-900 border-gray-300'
            }
          `}
          aria-label={placeholder || t('clarification.datePlaceholder', 'Select a date')}
        />
      </div>
    </div>
  );

  /**
   * Render date range input
   */
  const renderDateRangeInput = () => {
    const dateRangeValue = value || {};

    return (
      <div className="space-y-3">
        {/* Start date */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            {t('clarification.startDate', 'Start Date')}
          </label>
          <div className="relative">
            <Icon
              name="calendar"
              size="sm"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
            />
            <input
              type="date"
              value={dateRangeValue.start || ''}
              onChange={e => handleDateRangeChange('start', e.target.value)}
              disabled={disabled}
              required={required}
              min={minDate}
              max={dateRangeValue.end || maxDate}
              className={`
                w-full pl-10 pr-4 py-3 text-sm border rounded-lg
                transition-colors min-h-[44px]
                focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100
                ${
                  disabled
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
                    : 'bg-white text-gray-900 border-gray-300'
                }
                ${validationError ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''}
              `}
              aria-label={t('clarification.startDate', 'Start Date')}
            />
          </div>
        </div>

        {/* Range indicator */}
        <div className="flex items-center justify-center">
          <Icon name="arrow-right" size="sm" className="text-gray-400" />
        </div>

        {/* End date */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            {t('clarification.endDate', 'End Date')}
          </label>
          <div className="relative">
            <Icon
              name="calendar"
              size="sm"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
            />
            <input
              type="date"
              value={dateRangeValue.end || ''}
              onChange={e => handleDateRangeChange('end', e.target.value)}
              disabled={disabled}
              required={required}
              min={dateRangeValue.start || minDate}
              max={maxDate}
              className={`
                w-full pl-10 pr-4 py-3 text-sm border rounded-lg
                transition-colors min-h-[44px]
                focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none
                dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100
                ${
                  disabled
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200'
                    : 'bg-white text-gray-900 border-gray-300'
                }
                ${validationError ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''}
              `}
              aria-label={t('clarification.endDate', 'End Date')}
            />
          </div>
        </div>
      </div>
    );
  };

  /**
   * Render the appropriate input based on type
   */
  const renderInput = () => {
    switch (inputType) {
      case 'number':
        return renderNumberInput();
      case 'date':
        return renderDateInput();
      case 'date_range':
        return renderDateRangeInput();
      case 'text':
      default:
        return renderTextInput();
    }
  };

  return (
    <div className="w-full">
      {renderInput()}

      {/* Validation error message */}
      {validationError && (
        <div className="flex items-center gap-1.5 mt-2 text-sm text-red-600 dark:text-red-400">
          <Icon name="exclamation-circle" size="sm" />
          <span>{validationError}</span>
        </div>
      )}
    </div>
  );
};

export default ClarificationInput;
