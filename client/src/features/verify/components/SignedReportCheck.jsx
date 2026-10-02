import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { verifySignedReport } from '../../../api/endpoints/provenance';
import { readBlobText } from '../../../api/endpoints/exports';
import {
  describeVerdict,
  describeVerifyError,
  extractSignedReport,
  formatBytes
} from '../utils/verifyResult';
import { formatDateTime, techniqueLabel } from './VerificationResult';

/**
 * Label/value rows of a `<dl>`; rows without a value are left out.
 *
 * @param {Object} props
 * @param {Array<{label: string, value: React.ReactNode, mono?: boolean}>} props.items
 * @returns {JSX.Element}
 */
function DetailRows({ items }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
      {items
        .filter(item => item.value)
        .map(item => (
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
  );
}

/**
 * "Check a signed report": paste or upload a report downloaded from `/verify`
 * (or its bare token) and confirm through `POST /api/provenance/report/verify`
 * that it was signed by a trusted detector and is unchanged (CoP 2.1.2).
 *
 * @returns {JSX.Element}
 */
function SignedReportCheck() {
  const { t, i18n } = useTranslation();
  const baseId = useId();
  const fileInputRef = useRef(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const inputId = `${baseId}-report`;
  const hintId = `${baseId}-report-hint`;
  const fileInputId = `${baseId}-report-file`;

  const loadFile = async file => {
    if (!file) return;
    setError(null);
    try {
      setInput(await readBlobText(file));
    } catch {
      setError(t('verify.report.readFailed', 'The file could not be read.'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async event => {
    event.preventDefault();
    setError(null);
    setOutcome(null);
    const token = extractSignedReport(input);
    if (!token) {
      setError(
        t(
          'verify.report.invalidInput',
          'This is not a verification report. Paste the downloaded report file or its "report" value.'
        )
      );
      return;
    }
    setBusy(true);
    try {
      setOutcome(await verifySignedReport(token));
    } catch (err) {
      const { key, fallback, params } = describeVerifyError(err);
      setError(t(key, { defaultValue: fallback, ...(params || {}) }));
    } finally {
      setBusy(false);
    }
  };

  const payload = outcome?.payload || null;
  const signer = outcome?.signer || null;
  const errors = Array.isArray(outcome?.errors) ? outcome.errors : [];
  const verdictKey = payload?.verdict ? describeVerdict(payload.verdict).key : null;
  const foundTechniques = Array.isArray(payload?.techniques)
    ? payload.techniques
        .filter(technique => technique.found && technique.valid !== false)
        .map(technique => techniqueLabel(t, technique))
    : [];

  const verdictLabel = key =>
    ({
      aiGenerated: t('verify.result.verdict.aiGenerated', 'AI-generated'),
      notDetected: t('verify.result.verdict.notDetected', 'No marking found'),
      inconclusive: t('verify.result.verdict.inconclusive', 'Inconclusive')
    })[key];

  const rows = payload
    ? [
        verdictKey && {
          label: t('verify.report.payload.verdict', 'Verdict'),
          value: verdictLabel(verdictKey)
        },
        {
          label: t('verify.report.payload.techniquesFound', 'Found by'),
          value: foundTechniques.length
            ? foundTechniques.join(', ')
            : t('verify.result.foundByNone', 'No technique found a marking.')
        },
        payload.checkedAt && {
          label: t('verify.report.payload.checkedAt', 'Checked at'),
          value: formatDateTime(payload.checkedAt, i18n.language)
        },
        (payload.detector?.installationUrl || payload.detector?.id) && {
          label: t('verify.report.payload.detector', 'Detector'),
          value: payload.detector.installationUrl || payload.detector.id
        },
        payload.content?.sha256 && {
          label: t('verify.report.payload.contentHash', 'Content SHA-256'),
          value: payload.content.sha256,
          mono: true
        },
        payload.content && {
          label: t('verify.report.payload.content', 'Content'),
          value: [payload.content.kind, payload.content.mimeType, formatBytes(payload.content.size)]
            .filter(Boolean)
            .join(' · ')
        }
      ].filter(Boolean)
    : [];

  return (
    <section
      aria-labelledby={`${baseId}-heading`}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 sm:p-6"
    >
      <h2
        id={`${baseId}-heading`}
        className="text-lg font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('verify.report.heading', 'Check a signed report')}
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'verify.report.description',
          'Paste a verification report or upload its .json file to confirm that a trusted detector signed it and that it has not been changed.'
        )}
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('verify.report.inputLabel', 'Report')}
        </label>
        <textarea
          id={inputId}
          value={input}
          onChange={event => setInput(event.target.value)}
          rows={4}
          disabled={busy}
          aria-describedby={hintId}
          placeholder={t(
            'verify.report.placeholder',
            'Paste the report JSON or the signed report token'
          )}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
        />
        <p id={hintId} className="text-xs text-gray-600 dark:text-gray-400">
          {t('verify.report.hint', 'The file saved with "Download signed report" works as it is.')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            id={fileInputId}
            type="file"
            accept="application/json,.json,.jws,.txt"
            className="sr-only peer"
            disabled={busy}
            onChange={event => loadFile(event.target.files?.[0] || null)}
          />
          <label
            htmlFor={fileInputId}
            className="cursor-pointer inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-800"
          >
            <Icon name="upload" size="sm" />
            {t('verify.report.upload', 'Upload report file')}
          </label>
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-400 dark:disabled:bg-gray-600"
          >
            {busy ? (
              <>
                <span
                  className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                  aria-hidden="true"
                />
                {t('verify.report.checking', 'Checking…')}
              </>
            ) : (
              <>
                <Icon name="shield-check" size="sm" />
                {t('verify.report.submit', 'Check report')}
              </>
            )}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div aria-live="polite" className="mt-4">
        {outcome && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
                  outcome.valid
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
                }`}
              >
                <Icon name={outcome.valid ? 'check-circle' : 'x-circle'} size="sm" />
                {outcome.valid
                  ? t('verify.report.valid', 'Signature valid')
                  : t('verify.report.invalid', 'Signature invalid')}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
                  outcome.trusted
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                }`}
              >
                <Icon name={outcome.trusted ? 'shield-check' : 'shield-exclamation'} size="sm" />
                {outcome.trusted
                  ? t('verify.report.trusted', 'Signed by a trusted certificate')
                  : t('verify.report.untrusted', 'The signer is not trusted by this installation')}
              </span>
            </div>

            {signer && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('verify.report.signer.heading', 'Signer')}
                </h3>
                <DetailRows
                  items={[
                    { label: t('verify.report.signer.subject', 'Subject'), value: signer.subject },
                    { label: t('verify.report.signer.issuer', 'Issuer'), value: signer.issuer },
                    {
                      label: t('verify.report.signer.validUntil', 'Valid until'),
                      value: formatDateTime(signer.notAfter, i18n.language)
                    },
                    {
                      label: t('verify.report.signer.fingerprint', 'Fingerprint (SHA-256)'),
                      value: signer.fingerprint,
                      mono: true
                    }
                  ]}
                />
              </div>
            )}

            {rows.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('verify.report.payload.heading', 'Report contents')}
                </h3>
                <DetailRows items={rows} />
              </div>
            )}

            {errors.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                  {t('verify.report.errors', 'Problems found')}
                </h3>
                <ul className="list-disc pl-5 text-sm text-gray-700 dark:text-gray-300">
                  {errors.map(message => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default SignedReportCheck;
