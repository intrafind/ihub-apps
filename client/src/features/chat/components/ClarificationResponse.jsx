import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Display component for answered clarification questions
 * Shows the question and answer in a compact, integrated format
 *
 * Features:
 * - Displays question with question mark icon
 * - Displays answer with check icon
 * - Supports different value types (string, array, object for date_range)
 * - Compact styling to integrate into message flow
 * - Visual distinction from regular messages
 *
 * Supports two API styles:
 * 1. Explicit props: question, answer, skipped as separate props
 * 2. Object style: response object containing answered, skipped, value, displayText
 *
 * @param {Object} props - Component properties
 * @param {string} props.question - The clarification question that was asked
 * @param {Object} props.response - Optional response object (alternative to explicit props)
 * @param {boolean} props.response.answered - Whether the question was answered
 * @param {boolean} props.response.skipped - Whether the question was skipped
 * @param {*} props.response.value - The actual value of the response
 * @param {string} props.response.displayText - Human-readable display text
 * @param {string|string[]|Object} props.answer - The user's response (if not using response object)
 * @param {Array<{label: string, value: string}>} props.options - Original options (for label lookup)
 * @param {'single_select'|'multi_select'|'text'|'number'|'date'|'date_range'} props.inputType - Type of input
 * @param {boolean} props.skipped - Whether the user skipped this question (if not using response object)
 * @param {string} props.context - Optional context that was shown with the question
 * @returns {JSX.Element} The ClarificationResponse component
 */
const ClarificationResponse = ({
  question,
  response,
  answer: answerProp,
  options = [],
  inputType = 'text',
  skipped: skippedProp = false,
  context
}) => {
  // Support both response object and explicit props
  const answer = response?.value ?? answerProp;
  const skipped = response?.skipped ?? skippedProp;
  const preformattedDisplayText = response?.displayText;
  const { t } = useTranslation();

  /**
   * Format the answer for display
   * Handles different value types and looks up labels for option values
   */
  const formattedAnswer = useMemo(() => {
    // Use preformatted display text if available from response object
    if (preformattedDisplayText) {
      return preformattedDisplayText;
    }

    if (skipped) {
      return t('clarification.skipped', 'Skipped');
    }

    if (answer === null || answer === undefined || answer === '') {
      return t('clarification.noAnswer', 'No answer provided');
    }

    // Handle date_range type
    if (inputType === 'date_range' && typeof answer === 'object' && !Array.isArray(answer)) {
      const startDate = answer.start ? new Date(answer.start).toLocaleDateString() : '';
      const endDate = answer.end ? new Date(answer.end).toLocaleDateString() : '';
      if (startDate && endDate) {
        return `${startDate} - ${endDate}`;
      }
      return startDate || endDate || t('clarification.noAnswer', 'No answer provided');
    }

    // Handle date type
    if (inputType === 'date' && answer) {
      return new Date(answer).toLocaleDateString();
    }

    // Handle array (multi-select)
    if (Array.isArray(answer)) {
      const labels = answer.map(val => {
        const option = options.find(o => o.value === val);
        return option ? option.label : val;
      });
      return labels.join(', ');
    }

    // Handle single value (check if it's an option value)
    if (options.length > 0) {
      const option = options.find(o => o.value === answer);
      if (option) {
        return option.label;
      }
    }

    return String(answer);
  }, [answer, options, inputType, skipped, preformattedDisplayText, t]);

  return (
    <div className="flex flex-col gap-2 py-3 px-4 my-2 rounded-lg bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-800 border border-gray-200 dark:border-gray-700">
      {/* Question row */}
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 mt-0.5">
          <Icon
            name="question-mark-circle"
            size="sm"
            className="text-indigo-500 dark:text-indigo-400"
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{question}</p>
          {context && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 italic">{context}</p>
          )}
        </div>
      </div>

      {/* Answer row */}
      <div className="flex items-start gap-2 ml-6">
        <div className="flex-shrink-0 mt-0.5">
          <Icon
            name={skipped ? 'arrow-right' : 'check-circle'}
            size="sm"
            className={
              skipped ? 'text-gray-400 dark:text-gray-500' : 'text-green-500 dark:text-green-400'
            }
          />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm ${
              skipped
                ? 'text-gray-400 dark:text-gray-500 italic'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {formattedAnswer}
          </p>
        </div>
      </div>
    </div>
  );
};

export default ClarificationResponse;
