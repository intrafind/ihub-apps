import { useTranslation } from 'react-i18next';

/**
 * Clickable follow-up question chips shown below a completed assistant
 * response. Clicking a chip sends its text as the next user message.
 *
 * @param {Object} props
 * @param {string[]} props.suggestions - Follow-up question strings (max 3 expected)
 * @param {Function} props.onSelect - Called with the suggestion text when a chip is clicked
 */
function FollowUpChips({ suggestions, onSelect }) {
  const { t } = useTranslation();

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={t('followup.suggestions', 'Follow-up suggestions')}
      className="flex flex-wrap gap-2 mt-2"
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={`${index}-${suggestion}`}
          type="button"
          role="option"
          aria-selected="false"
          onClick={() => onSelect(suggestion)}
          className="inline-flex items-center px-3.5 py-2 rounded-full text-sm font-medium
            min-h-[36px] transition-colors duration-150 ease-in-out
            bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600
            focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

export default FollowUpChips;
