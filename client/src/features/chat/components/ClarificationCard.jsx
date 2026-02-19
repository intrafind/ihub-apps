import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ClarificationChips from './ClarificationChips';
import ClarificationDropdown from './ClarificationDropdown';
import ClarificationInput from './ClarificationInput';

/**
 * Maximum number of options to display as chips before switching to dropdown
 */
const CHIP_THRESHOLD = 4;

/**
 * Main container component for displaying clarification questions
 * Renders the appropriate input component based on inputType and manages
 * the submit/skip flow
 *
 * Features:
 * - Displays question with optional context
 * - Automatically selects chip or dropdown based on option count
 * - Handles all input types: single_select, multi_select, text, number, date, date_range, file
 * - Submit and skip actions
 * - Full accessibility with ARIA attributes and focus management
 * - Keyboard navigation support
 *
 * Supports two API styles:
 * 1. Explicit props: question, inputType, options, etc. as separate props
 * 2. Object style: clarification object containing all fields
 *
 * @param {Object} props - Component properties
 * @param {Object} props.clarification - Optional clarification object containing all fields
 * @param {string} props.clarification.questionId - Unique ID for the question
 * @param {string} props.clarification.question - The question text
 * @param {string} props.clarification.inputType - Input type
 * @param {Array} props.clarification.options - Options for select types
 * @param {boolean} props.clarification.allowOther - Allow custom input
 * @param {boolean} props.clarification.allowSkip - Allow skipping
 * @param {string} props.clarification.context - Additional context
 * @param {string} props.question - The clarification question to display (if not using clarification object)
 * @param {'single_select'|'multi_select'|'text'|'number'|'date'|'date_range'|'file'} props.inputType - Type of input
 * @param {Array<{label: string, value: string, description?: string}>} props.options - Options for select types
 * @param {boolean} props.allowOther - Whether to allow custom "Other" input for select types
 * @param {boolean} props.allowSkip - Whether the user can skip this question
 * @param {string} props.placeholder - Placeholder text for input
 * @param {string} props.context - Optional context to display with the question
 * @param {function} props.onSubmit - Callback when user submits an answer
 * @param {function} props.onSkip - Callback when user skips the question
 * @param {boolean} props.disabled - Whether the card is disabled
 * @param {Object} props.validation - Validation constraints (min, max, minDate, maxDate)
 * @returns {JSX.Element} The ClarificationCard component
 */
const ClarificationCard = ({
  // Support both clarification object and explicit props
  clarification,
  question: questionProp,
  inputType: inputTypeProp = 'text',
  options: optionsProp = [],
  allowOther: allowOtherProp = false,
  allowSkip: allowSkipProp = true,
  placeholder: placeholderProp,
  context: contextProp,
  onSubmit,
  onSkip,
  disabled = false,
  validation = {}
}) => {
  // Extract values from clarification object if provided, otherwise use direct props
  const questionId = clarification?.questionId;
  const question = clarification?.question || questionProp;
  const inputType = clarification?.inputType || inputTypeProp;
  const options = clarification?.options || optionsProp;
  const allowOther = clarification?.allowOther ?? allowOtherProp;
  const allowSkip = clarification?.allowSkip ?? allowSkipProp;
  const placeholder = clarification?.placeholder || placeholderProp;
  const context = clarification?.context || contextProp;
  const { t } = useTranslation();
  const [value, setValue] = useState(inputType === 'multi_select' ? [] : '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cardRef = useRef(null);
  const questionRef = useRef(null);
  const firstFocusableRef = useRef(null);

  /**
   * Determine if submit button should be enabled
   */
  const canSubmit = useCallback(() => {
    if (disabled || isSubmitting) return false;

    switch (inputType) {
      case 'multi_select':
        return Array.isArray(value) && value.length > 0;
      case 'date_range':
        return value && typeof value === 'object' && value.start && value.end;
      case 'number':
        return value !== '' && value !== null && value !== undefined;
      default:
        return value !== '' && value !== null && value !== undefined;
    }
  }, [value, inputType, disabled, isSubmitting]);

  /**
   * Get display text for the current value
   * @returns {string} Human-readable display text
   */
  const getDisplayText = useCallback(() => {
    if (inputType === 'date_range' && typeof value === 'object' && value.start && value.end) {
      return `${new Date(value.start).toLocaleDateString()} - ${new Date(value.end).toLocaleDateString()}`;
    }
    if (inputType === 'date' && value) {
      return new Date(value).toLocaleDateString();
    }
    if (Array.isArray(value)) {
      return value
        .map(v => {
          const opt = options.find(o => o.value === v);
          return opt ? opt.label : v;
        })
        .join(', ');
    }
    if (options.length > 0) {
      const opt = options.find(o => o.value === value);
      if (opt) return opt.label;
    }
    return String(value);
  }, [value, inputType, options]);

  /**
   * Handle form submission
   */
  const handleSubmit = useCallback(async () => {
    if (!canSubmit()) return;

    setIsSubmitting(true);
    try {
      // If using clarification object pattern, include full response structure
      if (questionId !== undefined) {
        await onSubmit({
          questionId,
          answered: true,
          skipped: false,
          value,
          displayText: getDisplayText()
        });
      } else {
        // Simple value-only response for explicit props pattern
        await onSubmit(value);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [value, canSubmit, onSubmit, questionId, getDisplayText]);

  /**
   * Handle skip action
   */
  const handleSkip = useCallback(async () => {
    if (disabled || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // If using clarification object pattern, include full response structure
      if (questionId !== undefined) {
        await onSkip({
          questionId,
          answered: false,
          skipped: true,
          value: null,
          displayText: t('clarification.skipped', 'Skipped')
        });
      } else {
        // Simple callback for explicit props pattern
        await onSkip();
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [disabled, isSubmitting, onSkip, questionId, t]);

  /**
   * Handle keyboard events for the card
   */
  const handleKeyDown = useCallback(
    e => {
      // Submit on Ctrl/Cmd + Enter
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canSubmit()) {
          handleSubmit();
        }
      }
    },
    [canSubmit, handleSubmit]
  );

  /**
   * Focus the first focusable element when the card mounts
   */
  useEffect(() => {
    if (cardRef.current) {
      // Find the first focusable element
      const focusable = cardRef.current.querySelector(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable) {
        firstFocusableRef.current = focusable;
        focusable.focus();
      }
    }
  }, []);

  /**
   * Trap focus within the card for accessibility
   */
  useEffect(() => {
    const handleTabKey = e => {
      if (e.key !== 'Tab' || !cardRef.current) return;

      const focusableElements = cardRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => document.removeEventListener('keydown', handleTabKey);
  }, []);

  /**
   * Render the appropriate input component based on inputType
   */
  const renderInput = () => {
    const isSelectType = inputType === 'single_select' || inputType === 'multi_select';
    const isMultiSelect = inputType === 'multi_select';

    // For select types, choose between chips and dropdown based on option count
    if (isSelectType) {
      // FALLBACK: If no options provided and no allowOther, fall back to text input
      // This handles cases where the LLM calls ask_user with select but forgets options
      if ((!options || options.length === 0) && !allowOther) {
        console.warn(
          'ClarificationCard: select/multi_select type with no options, falling back to text input'
        );
        return (
          <ClarificationInput
            inputType="text"
            value={value}
            onChange={setValue}
            placeholder={placeholder || t('clarification.typeYourAnswer', 'Type your answer...')}
            disabled={disabled || isSubmitting}
          />
        );
      }

      const useChips = options.length <= CHIP_THRESHOLD;

      if (useChips) {
        return (
          <ClarificationChips
            options={options}
            multiSelect={isMultiSelect}
            allowOther={allowOther}
            value={value}
            onChange={setValue}
            disabled={disabled || isSubmitting}
          />
        );
      }

      return (
        <ClarificationDropdown
          options={options}
          multiSelect={isMultiSelect}
          allowOther={allowOther}
          value={value}
          onChange={setValue}
          placeholder={placeholder}
          disabled={disabled || isSubmitting}
        />
      );
    }

    // For file type, show a file upload placeholder
    // (File upload implementation would need to be added based on existing file upload components)
    if (inputType === 'file') {
      return (
        <div className="flex items-center justify-center p-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg">
          <div className="text-center">
            <Icon name="paper-clip" size="lg" className="mx-auto text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('clarification.fileUploadPlaceholder', 'File upload not yet implemented')}
            </p>
          </div>
        </div>
      );
    }

    // For other input types (text, number, date, date_range)
    return (
      <ClarificationInput
        inputType={inputType}
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        disabled={disabled || isSubmitting}
        min={validation.min}
        max={validation.max}
        minDate={validation.minDate}
        maxDate={validation.maxDate}
      />
    );
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="clarification-question"
      className={`
        w-full max-w-lg p-5 rounded-xl
        bg-white dark:bg-gray-800
        border-2 border-indigo-100 dark:border-indigo-900/50
        shadow-lg shadow-indigo-500/5
        transition-all duration-200
        ${disabled ? 'opacity-60' : ''}
      `}
      onKeyDown={handleKeyDown}
    >
      {/* Question section */}
      <div className="mb-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
              <Icon
                name="question-mark-circle"
                size="md"
                className="text-indigo-600 dark:text-indigo-400"
              />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <h3
              id="clarification-question"
              ref={questionRef}
              className="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              {question}
            </h3>
            {context && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{context}</p>}
          </div>
        </div>
      </div>

      {/* Input section */}
      <div className="mb-5">{renderInput()}</div>

      {/* Action buttons */}
      <div className="flex items-center justify-between gap-3">
        {/* Skip button (left side) */}
        <div>
          {allowSkip && (
            <button
              type="button"
              onClick={handleSkip}
              disabled={disabled || isSubmitting}
              className={`
                px-4 py-2.5 text-sm font-medium rounded-lg
                transition-colors min-h-[44px]
                focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400
                ${
                  disabled || isSubmitting
                    ? 'text-gray-300 cursor-not-allowed dark:text-gray-600'
                    : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
                }
              `}
              aria-label={t('clarification.skip', 'Skip this question')}
            >
              {t('clarification.skip', 'Skip')}
            </button>
          )}
        </div>

        {/* Submit button (right side) */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit()}
          className={`
            flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg
            transition-colors min-h-[44px]
            focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500
            ${
              !canSubmit()
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
                : 'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600'
            }
          `}
          aria-label={t('clarification.submit', 'Submit answer')}
        >
          {isSubmitting ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
              <span>{t('clarification.submitting', 'Submitting...')}</span>
            </>
          ) : (
            <>
              <Icon name="check" size="sm" />
              <span>{t('clarification.submit', 'Submit')}</span>
            </>
          )}
        </button>
      </div>

      {/* Keyboard shortcut hint */}
      <p className="mt-3 text-xs text-center text-gray-400 dark:text-gray-500">
        {t('clarification.keyboardHint', 'Press Ctrl+Enter to submit')}
      </p>
    </div>
  );
};

export default ClarificationCard;
