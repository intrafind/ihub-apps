import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { DEFAULT_WATERMARK_MIN_TOKENS } from '../../../../../shared/aiTransparency.js';
import { VERIFY_PATH, describeTextMarking } from '../utils/aiTransparency';

/**
 * English fallbacks for why an answer is exempt from marking, keyed by the
 * provenance `marking.reason` (i18n key `aiTransparency.chip.exemptReason.<key>`).
 */
const EXEMPT_REASON_FALLBACKS = Object.freeze({
  standardEditing: 'standard editing (e.g. translation, grammar)',
  b2bTechnical: 'technical B2B output',
  transcription: 'transcription',
  other: 'declared by the administrator'
});

/**
 * Format an ISO timestamp for the viewer's language; falls back to the raw
 * value when the browser cannot parse it.
 *
 * @param {string} value - ISO 8601 timestamp
 * @param {string} language - i18n language code
 * @returns {string}
 */
function formatGeneratedAt(value, language) {
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
 * The model line of the second layer: the configured display name when the
 * surface knows the model, plus its id.
 *
 * @param {string|null} modelId - Model id from provenance or the fallback prop
 * @param {Array<Object>} models - Models the surface knows (may be empty)
 * @param {string} language - i18n language code
 * @returns {string}
 */
function modelLabel(modelId, models, language) {
  if (!modelId) return '';
  const known = Array.isArray(models) ? models.find(m => m?.id === modelId) : null;
  const name = known ? getLocalizedContent(known.name, language) : '';
  return name && name !== modelId ? `${name} (${modelId})` : modelId;
}

/**
 * Link to the detection page. Inside the web app's router it is a router
 * link (which resolves the deployment's base path); elsewhere a plain link.
 * Opens in a new tab so a running chat is never interrupted.
 */
function VerifyLink({ className, children }) {
  const inRouter = useInRouterContext();
  const props = { className, target: '_blank', rel: 'noopener noreferrer' };
  return inRouter ? (
    <Link to={VERIFY_PATH} {...props}>
      {children}
    </Link>
  ) : (
    <a href={VERIFY_PATH} {...props}>
      {children}
    </a>
  );
}

/**
 * "AI generated" chip on an assistant answer, with a second layer (EU AI Act
 * Art. 50, concept §6 item 2): the model, when it was generated, how it is
 * machine-readably marked, its content id and a link to verify it.
 *
 * Accessible disclosure pattern: a real button with `aria-expanded` /
 * `aria-controls`; the panel follows it in reading order, Escape closes it
 * and returns focus to the button. The panel is rendered inline (it wraps
 * onto its own line in the parent flex row via `basis-full order-last`), so
 * it is never clipped by the scrolling message list.
 *
 * @param {Object} props
 * @param {Object|null} [props.provenance] - `message.provenance` (public record from the server)
 * @param {string|null} [props.fallbackModelId] - Model shown when there is no provenance record
 * @param {Array<Object>} [props.models] - Known models, to show display names
 * @returns {JSX.Element}
 */
function AIProvenanceChip({ provenance = null, fallbackModelId = null, models = [] }) {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelId = useId();
  const headingId = useId();

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const hasRecord = Boolean(provenance && typeof provenance === 'object');
  const modelId = (hasRecord ? provenance.model?.id : null) || fallbackModelId || null;
  const minTokens =
    Number(platformConfig?.aiTransparency?.text?.watermarkMinTokens) ||
    DEFAULT_WATERMARK_MIN_TOKENS;
  const label = t('aiTransparency.chip.label', 'AI generated');

  const markingText = () => {
    const marking = describeTextMarking(provenance);
    switch (marking.status) {
      case 'marked-vllm':
        return t(
          'aiTransparency.chip.marking.markedVllm',
          'Marked with an invisible text watermark (self-hosted vLLM)'
        );
      case 'marked-upstream':
        return t(
          'aiTransparency.chip.marking.markedUpstream',
          'Marked by the model vendor ({{vendor}})',
          {
            vendor: marking.vendor
          }
        );
      case 'marked':
        return t('aiTransparency.chip.marking.marked', 'Marked with an invisible watermark');
      case 'unmarked':
        return marking.reason === 'temperature-zero'
          ? t(
              'aiTransparency.chip.marking.unmarkedTemperatureZero',
              'Not marked: no watermark can be embedded at temperature 0 (text over {{count}} tokens)',
              { count: minTokens }
            )
          : t(
              'aiTransparency.chip.marking.unmarked',
              'Not marked: the model does not watermark its output (text over {{count}} tokens)',
              { count: minTokens }
            );
      case 'not-required':
        return t(
          'aiTransparency.chip.marking.notRequired',
          'Not required: short text (up to {{count}} tokens)',
          { count: minTokens }
        );
      case 'exempt': {
        const reasonKey = EXEMPT_REASON_FALLBACKS[marking.reason] ? marking.reason : 'other';
        return t('aiTransparency.chip.marking.exempt', 'Exempt: {{reason}}', {
          reason: t(
            `aiTransparency.chip.exemptReason.${reasonKey}`,
            EXEMPT_REASON_FALLBACKS[reasonKey]
          )
        });
      }
      default:
        return t('aiTransparency.chip.marking.unknown', 'Not recorded for this answer');
    }
  };

  const generatorLine =
    hasRecord && provenance.generator?.name
      ? [provenance.generator.name, provenance.generator.version].filter(Boolean).join(' ')
      : '';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        title={t('aiTransparency.chip.tooltip', 'Generated by an AI system — show details')}
        className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-800 hover:bg-indigo-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:border-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-100 dark:hover:bg-indigo-900/60"
      >
        <Icon name="sparkles" className="h-3 w-3" aria-hidden="true" />
        <span>{label}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="order-last basis-full rounded-lg border border-gray-200 bg-white p-3 text-left text-xs text-gray-700 shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          <p id={headingId} className="font-semibold text-gray-900 dark:text-gray-100">
            {t('aiTransparency.chip.panelTitle', 'About this answer')}
          </p>
          <p className="mt-1">
            {t('aiTransparency.chip.generatedInApp', 'Generated by AI in this app')}
            {generatorLine ? ` (${generatorLine})` : ''}
          </p>
          {(modelId || hasRecord) && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {modelId && (
                <>
                  <dt className="font-medium text-gray-500 dark:text-gray-400">
                    {t('aiTransparency.chip.model', 'Model')}
                  </dt>
                  <dd className="min-w-0 break-words">
                    {modelLabel(modelId, models, i18n.language)}
                  </dd>
                </>
              )}
              {hasRecord && provenance.generatedAt && (
                <>
                  <dt className="font-medium text-gray-500 dark:text-gray-400">
                    {t('aiTransparency.chip.generatedAt', 'Generated at')}
                  </dt>
                  <dd>
                    <time dateTime={provenance.generatedAt}>
                      {formatGeneratedAt(provenance.generatedAt, i18n.language)}
                    </time>
                  </dd>
                </>
              )}
              {hasRecord && (
                <>
                  <dt className="font-medium text-gray-500 dark:text-gray-400">
                    {t('aiTransparency.chip.markingLabel', 'Marking')}
                  </dt>
                  <dd className="min-w-0 break-words">{markingText()}</dd>
                </>
              )}
              {hasRecord && provenance.contentId && (
                <>
                  <dt className="font-medium text-gray-500 dark:text-gray-400">
                    {t('aiTransparency.chip.contentId', 'Content ID')}
                  </dt>
                  <dd className="min-w-0 break-all">
                    <code className="font-mono">{provenance.contentId}</code>
                  </dd>
                </>
              )}
            </dl>
          )}
          <VerifyLink className="mt-2 inline-flex items-center gap-1 font-medium text-indigo-700 underline hover:text-indigo-900 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200">
            {t('aiTransparency.chip.verify', 'Verify content')}
            <Icon name="external-link" className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">
              {t('aiTransparency.common.opensInNewTab', '(opens in a new tab)')}
            </span>
          </VerifyLink>
        </div>
      )}
    </>
  );
}

export default AIProvenanceChip;
