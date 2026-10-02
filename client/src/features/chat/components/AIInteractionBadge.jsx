import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Persistent "AI" pill next to the chat input — the always-visible part of
 * the EU AI Act Art. 50(1) interaction disclosure. Text plus icon (never
 * colour alone), a `title` tooltip for pointer users and a full sentence for
 * screen readers; the visible "AI" is hidden from assistive tech so the
 * sentence is read once, not "AI, You are interacting…".
 *
 * Purely presentational: whether it shows is decided by the caller from
 * `getInteractionDisclosure()` (features/chat/utils/aiTransparency.js).
 *
 * @returns {JSX.Element}
 */
function AIInteractionBadge() {
  const { t } = useTranslation();
  const description = t('aiTransparency.badge.srText', 'You are interacting with an AI system');

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold leading-tight text-indigo-800 dark:border-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-100"
      title={t('aiTransparency.badge.tooltip', 'You are interacting with an AI system')}
      data-testid="ai-interaction-badge"
    >
      <Icon name="sparkles" size="xs" aria-hidden="true" />
      <span aria-hidden="true">{t('aiTransparency.badge.text', 'AI')}</span>
      <span className="sr-only">{description}</span>
    </span>
  );
}

export default AIInteractionBadge;
