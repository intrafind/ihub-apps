import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * English fallbacks for the sensitive-context categories (guidelines ¶40),
 * keyed as `SENSITIVE_CATEGORIES` in shared/aiTransparency.js. i18n key:
 * `aiTransparency.categories.<category>`.
 */
const CATEGORY_FALLBACKS = Object.freeze({
  legal: 'legal',
  finance: 'financial',
  health: 'health',
  complaints: 'complaint',
  vulnerable: 'personal'
});

/**
 * Periodic reminder below an answer of a sensitive app: people in legal,
 * financial, health, complaint or vulnerable-person contexts are reminded at
 * intervals that they are talking to an AI system (EU AI Act Art. 50(1),
 * guidelines ¶40). Which answers get one is decided by
 * `getReminderMessageIds()`; this component only renders the note.
 *
 * @param {Object} props
 * @param {string} props.category - One of `SENSITIVE_CATEGORIES`
 * @returns {JSX.Element}
 */
function AIReminderNotice({ category }) {
  const { t } = useTranslation();
  const categoryLabel = CATEGORY_FALLBACKS[category]
    ? t(`aiTransparency.categories.${category}`, CATEGORY_FALLBACKS[category])
    : category;

  return (
    <div
      role="note"
      className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100"
    >
      <Icon name="information-circle" size="sm" className="mt-px shrink-0" aria-hidden="true" />
      <p className="min-w-0 leading-snug">
        {t(
          'aiTransparency.reminder.text',
          'Reminder: you are talking to an AI system, not a person. For {{category}} matters, check important information with a qualified person.',
          { category: categoryLabel }
        )}
      </p>
    </div>
  );
}

export default AIReminderNotice;
