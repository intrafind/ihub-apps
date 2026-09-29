import { useTranslation } from 'react-i18next';
import { formatDateTime, normalizeRecord } from '../../utils/euAiAct';

/**
 * Shows who made an EU AI Act record, when, why and on which installation.
 * Works for disclosure opt-outs, exemptions, model acknowledgements and
 * warning dismissals (see `normalizeRecord`).
 *
 * @param {Object} props
 * @param {Object|null} props.record - The raw record from the server.
 * @param {string} [props.reasonLabel] - Label for the reason/justification.
 * @param {boolean} [props.compact=false] - Condensed lines for table cells
 *   (who/when, reason, installation) instead of a definition list.
 */
function RecordSummary({ record, reasonLabel, compact = false }) {
  const { t, i18n } = useTranslation();
  const normalized = normalizeRecord(record);
  if (!normalized) return null;

  const who =
    normalized.byName && normalized.by && normalized.byName !== normalized.by
      ? `${normalized.byName} (${normalized.by})`
      : normalized.byName || normalized.by || t('admin.euAiAct.record.unknownUser', 'unknown user');
  const when = formatDateTime(normalized.at, i18n.language);
  const installation = [
    normalized.installationUrl,
    normalized.installationId,
    normalized.ihubVersion
      ? t('admin.euAiAct.record.version', 'iHub {{version}}', { version: normalized.ihubVersion })
      : null
  ]
    .filter(Boolean)
    .join(' · ');

  if (compact) {
    return (
      <div className="text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
        <div>{t('admin.euAiAct.record.byAt', '{{who}}, {{when}}', { who, when })}</div>
        {normalized.reason && (
          <div className="text-gray-800 dark:text-gray-100 whitespace-normal break-words">
            “{normalized.reason}”
          </div>
        )}
        {installation && (
          <div className="text-gray-500 dark:text-gray-400 break-all">{installation}</div>
        )}
      </div>
    );
  }

  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="font-medium text-gray-500 dark:text-gray-400">
        {t('admin.euAiAct.record.by', 'By')}
      </dt>
      <dd className="text-gray-900 dark:text-gray-100 break-words">{who}</dd>
      <dt className="font-medium text-gray-500 dark:text-gray-400">
        {t('admin.euAiAct.record.at', 'When')}
      </dt>
      <dd className="text-gray-900 dark:text-gray-100">{when || '—'}</dd>
      {normalized.reason && (
        <>
          <dt className="font-medium text-gray-500 dark:text-gray-400">
            {reasonLabel || t('admin.euAiAct.record.reason', 'Reason')}
          </dt>
          <dd className="text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
            {normalized.reason}
          </dd>
        </>
      )}
      {installation && (
        <>
          <dt className="font-medium text-gray-500 dark:text-gray-400">
            {t('admin.euAiAct.record.installation', 'Installation')}
          </dt>
          <dd className="text-gray-900 dark:text-gray-100 break-all">{installation}</dd>
        </>
      )}
    </dl>
  );
}

export default RecordSummary;
