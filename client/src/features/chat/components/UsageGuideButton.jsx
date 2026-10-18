import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The control that opens an app's usage guide in a dialog (issue #2838). It is
 * one control with one label wherever it appears — under the chat input, in the
 * start form's action row — so users find it in the same place and by the same
 * name in every state. It is a button for help, not a prompt: the guide never
 * enters the chat.
 *
 * The visible text is the accessible name (WCAG 2.5.3). The line below the
 * input is shared with the AI disclaimer and the incognito toggle, so the label
 * is shorter still on phones. The pseudo-element lifts the hit area to 44px
 * without making that tight line taller.
 *
 * @param {Object} props
 * @param {Function} props.onClick
 */
function UsageGuideButton({ onClick }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="relative flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-900/30 transition-colors before:absolute before:-inset-y-2 before:inset-x-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
    >
      <Icon name="question-mark-circle" size="sm" aria-hidden="true" />
      <span className="sm:hidden">{t('usageGuide.inlineLabelShort', 'Guide')}</span>
      <span className="hidden sm:inline">{t('usageGuide.inlineLabel', 'Usage guide')}</span>
    </button>
  );
}

export default UsageGuideButton;
