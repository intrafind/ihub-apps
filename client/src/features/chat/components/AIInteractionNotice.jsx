import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { getInteractionDisclosure, getProviderLegalEntity } from '../utils/aiTransparency';

/**
 * First-turn notice of the EU AI Act Art. 50(1) interaction disclosure:
 * people must know they are talking to an AI system "at the latest at the
 * first interaction", so this renders in the empty chat, BEFORE anything is
 * sent. It is deliberately not dismissible — hiding it before the first
 * message would defeat its purpose. After the first message the persistent
 * "AI" badge next to the input and the per-message chip take over.
 *
 * Shown when the platform has `interactionDisclosure.enabled` and
 * `interactionDisclosure.firstTurnNotice` on and the app is not opted out
 * (`app.aiTransparency.disclosure !== false`). The text is the app's own
 * `aiTransparency.firstTurnNotice` (localized) or the default wording, which
 * names the operating legal entity when one is configured.
 *
 * @param {Object} props
 * @param {Object|null} props.app - App as the chat client receives it (`GET /api/apps/:id`)
 * @param {string} [props.className] - Extra classes for the outer element (spacing)
 * @returns {JSX.Element|null}
 */
function AIInteractionNotice({ app, className = '' }) {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const aiConfig = platformConfig?.aiTransparency;

  if (!app || !getInteractionDisclosure(aiConfig, app).firstTurnNotice) return null;

  const customText = getLocalizedContent(app.aiTransparency?.firstTurnNotice, i18n.language);
  const legalEntity = getProviderLegalEntity(aiConfig);
  const provider = legalEntity
    ? t('aiTransparency.notice.operatedBy', ' operated by {{legalEntity}}', { legalEntity })
    : '';
  const text =
    typeof customText === 'string' && customText.trim()
      ? customText
      : t(
          'aiTransparency.notice.default',
          'You are chatting with an AI system{{provider}}. Answers are generated automatically and may be inaccurate — check important information.',
          { provider }
        );

  return (
    <div
      role="note"
      aria-label={t('aiTransparency.notice.label', 'Notice: AI system')}
      className={`flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-100 ${className}`}
    >
      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-300 bg-white px-1.5 py-px text-[11px] font-semibold leading-tight text-indigo-800 dark:border-indigo-600 dark:bg-indigo-900 dark:text-indigo-100">
        <Icon name="sparkles" size="xs" aria-hidden="true" />
        <span>{t('aiTransparency.badge.text', 'AI')}</span>
      </span>
      <p className="min-w-0 leading-snug">{text}</p>
    </div>
  );
}

export default AIInteractionNotice;
