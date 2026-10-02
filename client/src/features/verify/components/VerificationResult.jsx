import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  describeVerdict,
  formatBytes,
  getFindingTechniques,
  getTechniqueKey,
  getTechniqueStatus,
  getTechniqueTrust
} from '../utils/verifyResult';

const VERDICT_TONES = {
  ai: 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-900 dark:text-indigo-100',
  none: 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100',
  inconclusive:
    'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100'
};

const STATUS_STYLES = {
  found: {
    icon: 'check-circle',
    className: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200'
  },
  none: {
    icon: 'minus-circle',
    className: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
  },
  skipped: {
    icon: 'clock',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'
  },
  invalid: {
    icon: 'x-circle',
    className: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200'
  }
};

/**
 * Localised label of a technique, falling back to the server's English one.
 *
 * @param {Function} t
 * @param {Object} technique - `{ technique, label }`
 * @returns {string}
 */
export function techniqueLabel(t, technique) {
  const key = getTechniqueKey(technique?.technique);
  const fallback = technique?.label || technique?.technique || '';
  return key ? t(`verify.techniques.${key}`, fallback) : fallback;
}

/**
 * A date as the viewer reads it, or the raw value when it is not a date.
 *
 * @param {string} value
 * @param {string} language
 * @returns {string}
 */
export function formatDateTime(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString(language || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

/**
 * The short verdict card — rendered inside the page's polite live region, so
 * a screen reader announces the verdict when a check finishes.
 *
 * @param {Object} props
 * @param {Object} props.result - `result` of `POST /api/provenance/verify`
 * @returns {JSX.Element}
 */
export function VerdictSummary({ result }) {
  const { t } = useTranslation();
  const verdict = describeVerdict(result?.verdict);
  const findings = getFindingTechniques(result?.techniques);
  const foundBy = findings.map(technique => techniqueLabel(t, technique)).join(', ');

  const verdictTitle = {
    aiGenerated: t('verify.result.verdict.aiGenerated', 'AI-generated'),
    notDetected: t('verify.result.verdict.notDetected', 'No marking found'),
    inconclusive: t('verify.result.verdict.inconclusive', 'Inconclusive')
  }[verdict.key];
  const verdictDescription = {
    aiGenerated: t(
      'verify.result.verdictDescription.aiGenerated',
      'A marking identifies this content as generated or manipulated by AI.'
    ),
    notDetected: t(
      'verify.result.verdictDescription.notDetected',
      'None of the checked techniques found an AI marking.'
    ),
    inconclusive: t(
      'verify.result.verdictDescription.inconclusive',
      'A marking was found but could not be confirmed.'
    )
  }[verdict.key];

  return (
    <div className={`rounded-xl border-2 p-5 ${VERDICT_TONES[verdict.tone]}`}>
      <div className="flex items-start gap-4">
        <Icon name={verdict.icon} size="2xl" className="flex-none" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
            {t('verify.result.heading', 'Result')}
          </p>
          <p className="text-2xl font-bold">{verdictTitle}</p>
          <p className="mt-1 text-sm">{verdictDescription}</p>
          <p className="mt-2 text-sm font-medium">
            {findings.length > 0
              ? t('verify.result.foundBy', {
                  techniques: foundBy,
                  defaultValue: 'Found by: {{techniques}}'
                })
              : t('verify.result.foundByNone', 'No technique found a marking.')}
          </p>
          {result?.summary && <p className="mt-2 text-sm opacity-90">{result.summary}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * One label/value list (`<dl>`) of the result details.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {Array<{label: string, value: React.ReactNode, mono?: boolean}>} props.items
 * @returns {JSX.Element|null}
 */
function DetailList({ title, items }) {
  const visible = items.filter(
    item => item.value !== null && item.value !== undefined && item.value !== ''
  );
  if (visible.length === 0) return null;
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">{title}</h3>
      <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {visible.map(item => (
          <div key={item.label} className="contents">
            <dt className="text-gray-600 dark:text-gray-400">{item.label}</dt>
            <dd
              className={`text-gray-900 dark:text-gray-100 min-w-0 ${
                item.mono ? 'font-mono text-xs break-all' : 'break-words'
              }`}
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The details of a check: technique table, content, provenance and detector.
 *
 * @param {Object} props
 * @param {Object} props.outcome - `POST /api/provenance/verify` answer
 * @param {Function} props.onDownloadReport - Saves the report file
 * @param {string|null} [props.downloadError] - Shown when saving failed
 * @returns {JSX.Element}
 */
function VerificationResult({ outcome, onDownloadReport, downloadError = null }) {
  const { t, i18n } = useTranslation();
  const result = outcome?.result || {};
  const techniques = Array.isArray(result.techniques) ? result.techniques : [];
  const content = result.content || {};
  const provenance = result.provenance || null;
  const detector = result.detector || {};
  const signed = typeof outcome?.report === 'string' && outcome.report.length > 0;

  const statusLabel = status =>
    ({
      found: t('verify.result.status.found', 'Found'),
      none: t('verify.result.status.none', 'None'),
      skipped: t('verify.result.status.skipped', 'Skipped'),
      invalid: t('verify.result.status.invalid', 'Invalid')
    })[status];

  const kindLabel = kind =>
    t(`verify.result.kinds.${kind || 'other'}`, {
      defaultValue: kind || t('verify.result.kinds.other', 'Other')
    });

  const modelLabel = provenance?.model
    ? [provenance.model.id, provenance.model.provider ? `(${provenance.model.provider})` : null]
        .filter(Boolean)
        .join(' ')
    : null;
  const generatorLabel = provenance?.generator
    ? [provenance.generator.name, provenance.generator.version].filter(Boolean).join(' ')
    : null;

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        <Icon name="information-circle" size="sm" className="mt-0.5 flex-none" />
        <span>
          {t(
            'verify.result.caveat',
            'The absence of a mark does not prove that a person wrote the content: marks can be removed, and content from other tools may carry none.'
          )}{' '}
          {t('verify.result.notStored', 'The checked content was not stored.')}
        </span>
      </p>

      <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h3
          id="verify-techniques-heading"
          className="px-4 pt-4 text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('verify.result.techniques.caption', 'Checked techniques')}
        </h3>
        <div className="overflow-x-auto p-4">
          <table className="min-w-full text-sm" aria-labelledby="verify-techniques-heading">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('verify.result.techniques.technique', 'Technique')}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('verify.result.techniques.result', 'Result')}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t('verify.result.techniques.trust', 'Signature')}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  {t('verify.result.techniques.detail', 'Detail')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {techniques.map((technique, index) => {
                const status = getTechniqueStatus(technique);
                const trust = getTechniqueTrust(technique);
                const style = STATUS_STYLES[status];
                return (
                  <tr key={`${technique.technique}-${index}`} className="align-top">
                    <th
                      scope="row"
                      className="py-2 pr-4 text-left font-medium text-gray-900 dark:text-gray-100"
                    >
                      {techniqueLabel(t, technique)}
                    </th>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${style.className}`}
                      >
                        <Icon name={style.icon} size="xs" />
                        {statusLabel(status)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {trust === 'trusted' && (
                        <span className="inline-flex items-center gap-1 text-green-800 dark:text-green-300">
                          <Icon name="shield-check" size="xs" />
                          {t('verify.result.trust.trusted', 'Trusted')}
                        </span>
                      )}
                      {trust === 'untrusted' && (
                        <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300">
                          <Icon name="shield-exclamation" size="xs" />
                          {t('verify.result.trust.untrusted', 'Not trusted')}
                        </span>
                      )}
                      {trust === 'notApplicable' && (
                        <span className="text-gray-500 dark:text-gray-400">
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">
                            {t('verify.result.trust.notApplicable', 'Not applicable')}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-gray-700 dark:text-gray-300 break-words">
                      {technique.detail}
                      {technique.skipped && (
                        <span className="block text-xs text-gray-600 dark:text-gray-400">
                          {t('verify.result.skippedReason', {
                            reason: technique.skipped,
                            defaultValue: 'Not checked: {{reason}}'
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DetailList
          title={t('verify.result.content.heading', 'Content')}
          items={[
            { label: t('verify.result.content.kind', 'Kind'), value: kindLabel(content.kind) },
            { label: t('verify.result.content.type', 'Type'), value: content.mimeType },
            { label: t('verify.result.content.size', 'Size'), value: formatBytes(content.size) },
            {
              label: t('verify.result.content.sha256', 'SHA-256'),
              value: content.sha256,
              mono: true
            }
          ]}
        />
        {provenance && (
          <DetailList
            title={t('verify.result.provenance.heading', 'Provenance')}
            items={[
              {
                label: t('verify.result.provenance.generatedAt', 'Generated at'),
                value: formatDateTime(provenance.generatedAt, i18n.language)
              },
              { label: t('verify.result.provenance.model', 'Model'), value: modelLabel },
              {
                label: t('verify.result.provenance.generator', 'Generator'),
                value: generatorLabel
              },
              {
                label: t('verify.result.provenance.contentId', 'Content ID'),
                value: provenance.contentId,
                mono: true
              }
            ]}
          />
        )}
        <DetailList
          title={t('verify.result.detector.heading', 'Detector')}
          items={[
            {
              label: t('verify.result.detector.installationUrl', 'Installation'),
              value: detector.installationUrl
            },
            {
              label: t('verify.result.detector.id', 'Installation ID'),
              value: detector.id,
              mono: true
            },
            { label: t('verify.result.detector.version', 'Version'), value: detector.version },
            {
              label: t('verify.result.detector.checkedAt', 'Checked at'),
              value: formatDateTime(result.checkedAt, i18n.language)
            }
          ]}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <button
          type="button"
          onClick={onDownloadReport}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <Icon name="download" size="sm" />
          {signed
            ? t('verify.result.downloadReport', 'Download signed report')
            : t('verify.result.downloadUnsignedReport', 'Download report (unsigned)')}
        </button>
        {!signed && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t(
              'verify.result.unsignedNote',
              'This installation has no active signing certificate, so the report is not signed.'
            )}
          </p>
        )}
      </div>
      {downloadError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {downloadError}
        </p>
      )}
    </div>
  );
}

export default VerificationResult;
