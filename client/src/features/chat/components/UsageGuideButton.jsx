import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const VARIANT_CLASSES = {
  // Centered on the start screen, below the starter prompts or greeting.
  hint: 'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border border-indigo-200 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50',
  // On the line below the chat input, opposite the incognito toggle.
  inline:
    'flex items-center gap-1.5 px-2.5 py-1 min-h-6 rounded-full text-xs font-medium whitespace-nowrap text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
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
 * @param {boolean} [props.opensDialog] - The guide opens in a dialog, not the chat.
 */
function UsageGuideButton({
  question,
  onClick,
  disabled = false,
  variant = 'hint',
  opensDialog = false
}) {
  const { t } = useTranslation();
  const inline = variant === 'inline';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup={opensDialog ? 'dialog' : undefined}
      title={inline ? question : undefined}
      className={`transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${VARIANT_CLASSES[variant]}`}
    >
      <Icon name="question-mark-circle" size="sm" aria-hidden="true" />
      {/* The visible text is the accessible name (WCAG 2.5.3). The line below
          the input is shared with the AI disclaimer and the incognito toggle,
          so it gets a short label — shorter still on phones — and the full
          question as its tooltip. */}
      {inline ? (
        <>
          <span className="sm:hidden">{t('usageGuide.inlineLabelShort', 'Guide')}</span>
          <span className="hidden sm:inline">{t('usageGuide.inlineLabel', 'Usage guide')}</span>
        </>
      ) : (
        <span>{question}</span>
      )}
    </button>
  );
}

export default UsageGuideButton;
