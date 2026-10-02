import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownTrayIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { verifyContent } from './tabsApi';
import { downloadJsonFile, extractApiError, formatBytes, formatDateTime } from './fileHelpers';
import { buildReportDownload, verdictTone } from './detectionModel';
import { markingStatusLabel, techniqueLabel, verdictLabel } from './detectionLabels';
import {
  Button,
  DefinitionList,
  Notice,
  SectionCard,
  StatusPill,
  TABLE,
  TextField,
  YesNo
} from './EuAiActUi';

const FILE_INPUT_CLASS =
  'block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 dark:file:bg-indigo-900/40 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 dark:file:text-indigo-300 hover:file:bg-indigo-100';

/**
 * "Test detection" panel of the Detection tab: upload a file or paste text,
 * run it through `POST /api/provenance/verify` (the same detector `/verify`
 * uses) and show the verdict, the per-technique results, the provenance
 * details and a download of the signed detection report.
 *
 * The short verdict line is an `aria-live="polite"` region, so screen
 * readers hear the outcome without the whole result being read out.
 */
function DetectionTestPanel() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState('');
  const [checking, setChecking] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const handleCheck = async () => {
    if (mode === 'file' && !file) {
      setInputError(t('admin.euAiAct.detection.test.fileRequired', 'Choose a file to check.'));
      fileInputRef.current?.focus();
      return;
    }
    if (mode === 'text' && !text.trim()) {
      setInputError(t('admin.euAiAct.detection.test.textRequired', 'Paste the text to check.'));
      document.getElementById('eu-detect-text')?.focus();
      return;
    }
    setInputError('');
    setChecking(true);
    setError(null);
    setResponse(null);
    try {
      const data = await verifyContent(mode === 'file' ? { file } : { text });
      setResponse(data);
    } catch (err) {
      // ProvenanceRequestError carries `status`; the axios error (with the
      // server's `details`) is its `cause`.
      const base = extractApiError(err?.cause || err);
      setError({
        status: err?.status ?? base.status,
        message: err?.message || base.message,
        details: base.details
      });
    } finally {
      setChecking(false);
    }
  };

  const errorText = () => {
    if (!error) return '';
    if (error.status === 403) {
      return t(
        'admin.euAiAct.detection.test.forbidden',
        'Your account may not use the detector with the current access level.'
      );
    }
    if (error.status === 429) {
      return t(
        'admin.euAiAct.detection.test.rateLimited',
        'Too many checks in a short time. Try again later.'
      );
    }
    return t('admin.euAiAct.detection.test.error', 'The check failed: {{error}}', {
      error: error.message
    });
  };

  const result = response?.result || null;
  const reportDownload = buildReportDownload(response);
  const techniques = Array.isArray(result?.techniques) ? result.techniques : [];
  const provenance = result?.provenance || null;

  return (
    <SectionCard
      id="eu-detect-test"
      title={t('admin.euAiAct.detection.test.title', 'Test detection')}
      description={t(
        'admin.euAiAct.detection.test.description',
        'Check a file or a text with the detector of this installation, exactly as /verify does. Submitted content is not stored.'
      )}
    >
      <form
        noValidate
        onSubmit={event => {
          event.preventDefault();
          handleCheck();
        }}
        className="space-y-4"
      >
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.euAiAct.detection.test.mode', 'What do you want to check?')}
          </legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {[
              { value: 'file', label: t('admin.euAiAct.detection.test.modeFile', 'A file') },
              { value: 'text', label: t('admin.euAiAct.detection.test.modeText', 'Pasted text') }
            ].map(option => (
              <label
                key={option.value}
                className="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <input
                  type="radio"
                  name="eu-detect-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => {
                    setMode(option.value);
                    setInputError('');
                  }}
                  className="h-4 w-4 border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        {mode === 'file' ? (
          <div>
            <label
              htmlFor="eu-detect-file"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.euAiAct.detection.test.file', 'File to check')}
            </label>
            <input
              ref={fileInputRef}
              id="eu-detect-file"
              type="file"
              onChange={event => {
                setFile(event.target.files?.[0] || null);
                setInputError('');
              }}
              aria-invalid={inputError ? true : undefined}
              aria-describedby={`eu-detect-file-hint${inputError ? ' eu-detect-input-error' : ''}`}
              className={`mt-1 ${FILE_INPUT_CLASS}`}
            />
            <p id="eu-detect-file-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.euAiAct.detection.test.fileHint',
                'Images, PDF, Word, PowerPoint, Excel, HTML, JSON or text files.'
              )}
            </p>
          </div>
        ) : (
          <TextField
            id="eu-detect-text"
            multiline
            rows={8}
            value={text}
            onChange={value => {
              setText(value);
              setInputError('');
            }}
            label={t('admin.euAiAct.detection.test.text', 'Text to check')}
            hint={t(
              'admin.euAiAct.detection.test.textHint',
              'Paste the text exactly as received; invisible signpost characters must stay in place.'
            )}
          />
        )}
        {inputError && (
          <p id="eu-detect-input-error" className="text-sm text-red-600 dark:text-red-400">
            {inputError}
          </p>
        )}

        <Button type="submit" variant="primary" icon={MagnifyingGlassIcon} busy={checking}>
          {checking
            ? t('admin.euAiAct.detection.test.checking', 'Checking…')
            : t('admin.euAiAct.detection.test.submit', 'Check content')}
        </Button>
      </form>

      {/* Short, announced outcome. */}
      <div aria-live="polite" aria-atomic="true" className="text-sm">
        {checking && (
          <p className="text-gray-600 dark:text-gray-400">
            {t('admin.euAiAct.detection.test.checkingStatus', 'Checking the content…')}
          </p>
        )}
        {!checking && error && (
          <Notice tone="error" title={errorText()}>
            {error.details?.length > 0 && (
              <ul className="list-disc pl-5">
                {error.details.map(detail => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
        {!checking && result && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {t('admin.euAiAct.detection.test.verdictLabel', 'Result:')}
            </span>
            <StatusPill tone={verdictTone(result.verdict)}>
              {verdictLabel(t, result.verdict)}
            </StatusPill>
          </div>
        )}
      </div>

      {!checking && result && (
        <div className="space-y-5">
          {result.summary && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">
                {t('admin.euAiAct.detection.test.summary', 'Detector summary:')}
              </span>{' '}
              {result.summary}
            </p>
          )}

          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">
                {t('admin.euAiAct.detection.test.techniquesCaption', 'Results per technique')}
              </caption>
              <thead className={TABLE.thead}>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.test.colTechnique', 'Technique')}
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.test.colFound', 'Found')}
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.test.colValid', 'Valid')}
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.test.colTrusted', 'Trusted')}
                  </th>
                  <th scope="col" className={TABLE.th}>
                    {t('admin.euAiAct.detection.test.colDetail', 'Detail')}
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {techniques.length === 0 && (
                  <tr>
                    <td colSpan={5} className={TABLE.empty}>
                      {t('admin.euAiAct.detection.test.noTechniques', 'No technique was run.')}
                    </td>
                  </tr>
                )}
                {techniques.map(row => (
                  <tr key={row.technique} className={TABLE.tr}>
                    <th scope="row" className={`${TABLE.td} text-left font-medium`}>
                      {techniqueLabel(t, row.technique, row.label)}
                    </th>
                    <td className={TABLE.td}>
                      {row.skipped ? (
                        <StatusPill tone="neutral">
                          {t('admin.euAiAct.detection.test.skipped', 'Skipped')}
                        </StatusPill>
                      ) : (
                        <YesNo
                          value={row.found}
                          yes={t('admin.euAiAct.detection.test.yes', 'Yes')}
                          no={t('admin.euAiAct.detection.test.no', 'No')}
                        />
                      )}
                    </td>
                    <td className={TABLE.td}>
                      <YesNo
                        value={row.valid}
                        noIsBad
                        yes={t('admin.euAiAct.detection.test.yes', 'Yes')}
                        no={t('admin.euAiAct.detection.test.no', 'No')}
                      />
                    </td>
                    <td className={TABLE.td}>
                      <YesNo
                        value={row.trusted}
                        yes={t('admin.euAiAct.detection.test.yes', 'Yes')}
                        no={t('admin.euAiAct.detection.test.no', 'No')}
                      />
                    </td>
                    <td className={`${TABLE.td} break-words`}>
                      {row.detail}
                      {row.skipped && (
                        <span className="block text-xs text-gray-500 dark:text-gray-400">
                          {t('admin.euAiAct.detection.test.skippedReason', 'Skipped: {{reason}}', {
                            reason: row.skipped
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                {t('admin.euAiAct.detection.test.contentTitle', 'Checked content')}
              </h3>
              <DefinitionList
                items={[
                  {
                    label: t('admin.euAiAct.detection.test.kind', 'Kind'),
                    value: result.content?.kind || '—'
                  },
                  {
                    label: t('admin.euAiAct.detection.test.mimeType', 'MIME type'),
                    value: result.content?.mimeType || '—',
                    mono: true
                  },
                  {
                    label: t('admin.euAiAct.detection.test.size', 'Size'),
                    value: formatBytes(result.content?.size, locale)
                  },
                  {
                    label: t('admin.euAiAct.detection.test.checkedAt', 'Checked at'),
                    value: formatDateTime(result.checkedAt, locale)
                  },
                  {
                    label: t('admin.euAiAct.detection.test.sha256', 'SHA-256'),
                    value: result.content?.sha256 || '—',
                    mono: true
                  },
                  {
                    label: t('admin.euAiAct.detection.test.detector', 'Detector'),
                    value:
                      [result.detector?.installationUrl, result.detector?.version]
                        .filter(Boolean)
                        .join(' · ') || '—'
                  }
                ]}
              />
            </div>

            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                {t('admin.euAiAct.detection.test.provenanceTitle', 'Provenance')}
              </h3>
              {provenance ? (
                <DefinitionList
                  items={[
                    {
                      label: t('admin.euAiAct.detection.test.model', 'Model'),
                      value: provenance.model
                        ? [provenance.model.id, provenance.model.provider]
                            .filter(Boolean)
                            .join(' · ')
                        : '—'
                    },
                    {
                      label: t('admin.euAiAct.detection.test.generatedAt', 'Generated at'),
                      value: formatDateTime(provenance.generatedAt, locale)
                    },
                    {
                      label: t('admin.euAiAct.detection.test.generator', 'Generator'),
                      value: provenance.generator
                        ? [provenance.generator.name, provenance.generator.version]
                            .filter(Boolean)
                            .join(' ')
                        : '—'
                    },
                    {
                      label: t('admin.euAiAct.detection.test.provenanceKind', 'Origin'),
                      value: provenance.kind || '—'
                    },
                    {
                      label: t('admin.euAiAct.detection.test.marking', 'Marking'),
                      value: markingStatusLabel(t, provenance.marking?.status)
                    },
                    {
                      label: t('admin.euAiAct.detection.test.contentId', 'Content ID'),
                      value: provenance.contentId || '—',
                      mono: true
                    }
                  ]}
                />
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.euAiAct.detection.test.noProvenance',
                    'No provenance record of this installation matches the content.'
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              icon={ArrowDownTrayIcon}
              disabled={!reportDownload}
              onClick={() =>
                reportDownload && downloadJsonFile(reportDownload.filename, reportDownload.data)
              }
              aria-describedby="eu-detect-report-hint"
            >
              {t('admin.euAiAct.detection.test.downloadReport', 'Download signed report')}
            </Button>
            <p id="eu-detect-report-hint" className="text-xs text-gray-500 dark:text-gray-400">
              {reportDownload
                ? t(
                    'admin.euAiAct.detection.test.reportHint',
                    'JSON file with the signed report (JWS) and its decoded content, for auditors or the person who asked.'
                  )
                : t(
                    'admin.euAiAct.detection.test.noReport',
                    'No signed report is available for this check.'
                  )}
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export default DetectionTestPanel;
