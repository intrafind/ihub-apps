import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const VARIANT_CLASSES = {
  // Centered on the start screen, below the starter prompts or greeting.
  hint: 'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border border-indigo-200 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50',
  // On the line below the chat input, opposite the incognito toggle.
  inline:
    'flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-700'
};

/**
 * The button that shows an app's usage guide (issue #2838). It looks like a
 * question, and the chat answers it with the pre-written guide — no model call.
 *
 * @param {Object} props
 * @param {string} props.question - The guide's question, also the button's text.
 * @param {Function} props.onClick
 * @param {boolean} [props.disabled]
 * @param {'hint'|'inline'} [props.variant]
 */
function UsageGuideButton({ question, onClick, disabled = false, variant = 'hint' }) {
  const { t } = useTranslation();
  // The line below the input is shared with the AI disclaimer and the incognito
  // toggle, so it gets a short label; the question stays its accessible name.
  const label = variant === 'inline' ? t('usageGuide.inlineLabel', 'Usage guide') : question;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={question}
      title={question}
      className={`transition-colors disabled:opacity-50 ${VARIANT_CLASSES[variant]}`}
    >
      <Icon name="question-mark-circle" size="sm" />
      {/* Icon-only below `sm` on the input line, where the row is tight. */}
      <span className={variant === 'inline' ? 'hidden sm:inline' : undefined}>{label}</span>
    </button>
  );
}

export default UsageGuideButton;
