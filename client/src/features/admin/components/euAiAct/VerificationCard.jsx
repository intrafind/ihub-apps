// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { verifyFile, verifyText } from '../../../../api/euAiActAdminApi';
import EuAiActCard from './EuAiActCard';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './KeyDialogs';
import { summarizeVerification } from './verificationResult';
import PausedNote from './PausedNote';
import ProvenanceRecord from './ProvenanceRecord';
import { useEuAiActEnabled } from './EuAiActStateNote';

const MAX_TEXT_CHARS = 262144;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const ROW_BADGE = {
  found: { tone: 'success', icon: 'check-circle' },
  notFound: { tone: 'neutral', icon: 'information-circle' },
  inconclusive: { tone: 'warning', icon: 'exclamation-triangle' },
  info: { tone: 'neutral', icon: 'minus-circle' }
};

function rowTitle(row, t) {
  return {
    record: t('admin.euAiAct.verify.rowRecord', 'Output record (hash)'),
    watermark: t('admin.euAiAct.verify.rowWatermark', 'Watermark detection'),
    c2pa: t('admin.euAiAct.verify.rowC2pa', 'Content credentials (C2PA)'),
    synthid: t('admin.euAiAct.verify.rowSynthid', 'SynthID')
  }[row.id];
}

/** Badge word and sentence of one row. Negatives never claim an origin. */
function describeRow(row, t) {
  if (row.id === 'record') {
    return row.status === 'found'
      ? {
          word: t('admin.euAiAct.verify.found', 'Found'),
          text: t(
            'admin.euAiAct.verify.recordFound',
            'This installation produced exactly this output{{when}}{{model}}.',
            {
              when: row.createdAt
                ? ` ${t('admin.euAiAct.verify.on', 'on')} ${new Date(row.createdAt).toLocaleDateString()}`
                : '',
              model: row.modelId ? ` (${row.modelId})` : ''
            }
          )
        }
      : {
          word: t('admin.euAiAct.verify.notFound', 'Not found'),
          text: t(
            'admin.euAiAct.verify.recordNotFound',
            'No record of this exact content. It may have been edited, come from another system or be older than the retention period. This is not proof of its origin.'
          )
        };
  }
  if (row.id === 'watermark') {
    switch (row.state) {
      case 'detected':
        return {
          word: t('admin.euAiAct.verify.detected', 'Detected'),
          text: t(
            'admin.euAiAct.verify.wmDetected',
            'Watermark detected. Technique: iHub text watermark. Key ID: {{keyId}}. p-value {{p}}, {{n}} tokens scored.',
            { keyId: row.keyId || '-', p: row.pValue ?? '-', n: row.scoredTokens ?? '-' }
          )
        };
      case 'not_detected':
        return {
          word: t('admin.euAiAct.verify.notDetected', 'Not detected'),
          text: t(
            'admin.euAiAct.verify.wmNotDetected',
            'No watermark detected with the {{k}} keys held by this installation. This does not show that the text is not AI-generated: it may be edited, come from another model or have been generated without a watermark.',
            { k: row.keysChecked ?? '-' }
          )
        };
      case 'too_short':
        return {
          word: t('admin.euAiAct.verify.tooShort', 'Too short to tell'),
          text: t(
            'admin.euAiAct.verify.wmTooShort',
            'Only {{n}} tokens could be scored; about 200 are needed. No conclusion.',
            { n: row.scoredTokens ?? 0 }
          )
        };
      case 'unavailable':
        return {
          word: t('admin.euAiAct.verify.couldNot', 'Could not be checked'),
          text: t(
            'admin.euAiAct.verify.wmUnavailable',
            'The detector is not reachable. No conclusion.'
          )
        };
      case 'not_configured':
        return {
          word: t('admin.euAiAct.verify.notChecked', 'Not checked'),
          text: t('admin.euAiAct.verify.wmNotConfigured', 'No detector is configured.')
        };
      default:
        return {
          word: t('admin.euAiAct.verify.notChecked', 'Not checked'),
          text: t(
            'admin.euAiAct.verify.wmSkipped',
            'The watermark is checked when no record is found and you are signed in.'
          )
        };
    }
  }
  if (row.id === 'c2pa') {
    switch (row.state) {
      case 'present':
        return {
          word: t('admin.euAiAct.verify.present', 'present'),
          text: [
            t(
              'admin.euAiAct.verify.c2paPresent',
              'Content credentials present{{issuer}}{{source}}. Signature {{valid}}.',
              {
                issuer: row.issuer ? `: ${row.issuer}` : '',
                source: row.digitalSourceType
                  ? `, ${t('admin.euAiAct.verify.declaredAs', 'declared as {{type}}', { type: row.digitalSourceType })}`
                  : '',
                valid: row.valid
                  ? t('admin.euAiAct.verify.validTrust', 'valid (trust not evaluated)')
                  : t('admin.euAiAct.verify.notValid', 'could not be validated')
              }
            ),
            row.claimGenerator
              ? t('admin.euAiAct.verify.c2paGenerator', 'Made with: {{generator}}.', {
                  generator: row.claimGenerator
                })
              : '',
            row.signedAt
              ? t('admin.euAiAct.verify.c2paSignedAt', 'Signed on {{when}}.', {
                  when: new Date(row.signedAt).toLocaleString()
                })
              : ''
          ]
            .filter(Boolean)
            .join(' ')
        };
      case 'absent':
        return {
          word: t('admin.euAiAct.verify.notFound', 'Not found'),
          text: t(
            'admin.euAiAct.verify.c2paAbsent',
            'No content credentials found. Many tools remove them, so this proves nothing about the origin.'
          )
        };
      case 'unsupported_format':
        return {
          word: t('admin.euAiAct.verify.notChecked', 'Not checked'),
          text: t(
            'admin.euAiAct.verify.c2paUnsupported',
            'This file format is not read for content credentials.'
          )
        };
      case 'skipped':
        return {
          word: t('admin.euAiAct.verify.notChecked', 'Not checked'),
          text: t(
            'admin.euAiAct.verify.c2paSkipped',
            'Reading content credentials is switched off.'
          )
        };
      default:
        return {
          word: t('admin.euAiAct.verify.couldNot', 'Could not be checked'),
          text: t(
            'admin.euAiAct.verify.c2paUnreadable',
            'The content credentials could not be read. No conclusion.'
          )
        };
    }
  }
  return {
    word: t('admin.euAiAct.verify.declared', 'declared, not detectable'),
    text: t(
      'admin.euAiAct.verify.synthidDeclared',
      'The provider states it embeds SynthID. SynthID cannot be detected here.'
    )
  };
}

/**
 * Card 4: look up a pasted text or an uploaded image/audio file. The answer is
 * one row per technique; a negative or inconclusive row never says the content
 * is human-made or "not watermarked".
 */
export default function VerificationCard({ maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  const { t } = useTranslation();
  // Verification is one of the features the EU AI Act master switch turns off.
  const paused = !useEuAiActEnabled();
  const [mode, setMode] = useState('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const fileInputRef = useRef(null);

  const hasInput = mode === 'text' ? text.trim().length > 0 : Boolean(file);

  const pickFile = event => {
    const next = event.target.files?.[0] || null;
    setOutcome(null);
    if (next && next.size > maxFileBytes) {
      setFile(null);
      setError(
        t('admin.euAiAct.verify.tooLarge', 'The file is larger than {{mb}} MB.', {
          mb: Math.round(maxFileBytes / (1024 * 1024))
        })
      );
      event.target.value = '';
      return;
    }
    setError(null);
    setFile(next);
  };

  const submit = async event => {
    event.preventDefault();
    if (!hasInput || busy) return;
    if (mode === 'text' && text.length > MAX_TEXT_CHARS) {
      setError(
        t(
          'admin.euAiAct.verify.textTooLong',
          'The text is too long ({{max}} characters at most).',
          { max: MAX_TEXT_CHARS }
        )
      );
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result =
        mode === 'text'
          ? await verifyText(text)
          : await verifyFile(
              file,
              file.type.startsWith('audio/')
                ? 'audio'
                : file.type.startsWith('image/')
                  ? 'image'
                  : undefined
            );
      setOutcome(summarizeVerification(result));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const headline =
    outcome &&
    {
      match: t('admin.euAiAct.verify.headlineMatch', 'Match found: see details.'),
      none: t(
        'admin.euAiAct.verify.headlineNone',
        'No match found. This is not proof that the content is not AI-generated.'
      ),
      inconclusive: t('admin.euAiAct.verify.headlineInconclusive', 'No conclusion possible.')
    }[outcome.headline];

  return (
    <EuAiActCard
      id="verification"
      title={t('admin.euAiAct.verify.title', 'Verification')}
      description={t(
        'admin.euAiAct.verify.description',
        'Check whether a text, image or audio file came from this installation and which marks it carries. The content is hashed and not stored.'
      )}
    >
      {paused && (
        <PausedNote>
          {t('admin.euAiAct.master.verifyOff', 'Verification is switched off.')}
        </PausedNote>
      )}
      <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={paused} className="space-y-4 min-w-0 border-0 p-0 m-0">
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.euAiAct.verify.kind', 'What do you want to check?')}
            </legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {['text', 'file'].map(value => (
                <label
                  key={value}
                  className="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100"
                >
                  <input
                    type="radio"
                    name="verify-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setOutcome(null);
                      setError(null);
                    }}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  {value === 'text'
                    ? t('admin.euAiAct.verify.modeText', 'Text')
                    : t('admin.euAiAct.verify.modeFile', 'Image or audio file')}
                </label>
              ))}
            </div>
          </fieldset>

          {mode === 'text' ? (
            <div>
              <label
                htmlFor="verify-text"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.euAiAct.verify.textLabel', 'Text to check')}
              </label>
              <textarea
                id="verify-text"
                rows={6}
                value={text}
                onChange={e => setText(e.target.value)}
                aria-describedby="verify-text-help"
                className={`mt-1 ${INPUT}`}
              />
              <p id="verify-text-help" className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {t(
                  'admin.euAiAct.verify.textHelp',
                  'Texts shorter than about 200 tokens cannot be judged by the watermark check.'
                )}
              </p>
            </div>
          ) : (
            <div>
              <p
                id="verify-file-label"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.euAiAct.verify.fileLabel', 'File to check')}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <input
                  ref={fileInputRef}
                  id="verify-file"
                  type="file"
                  accept="image/*,audio/*"
                  onChange={pickFile}
                  aria-labelledby="verify-file-label"
                  aria-describedby="verify-file-help"
                  className="text-sm text-gray-900 dark:text-gray-100 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border file:border-gray-300 dark:file:border-gray-600 file:bg-white dark:file:bg-gray-800 file:text-sm file:font-medium file:text-gray-700 dark:file:text-gray-200"
                />
                {file && (
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className={BUTTON_SECONDARY}
                  >
                    {t('admin.euAiAct.verify.removeFile', 'Remove file')}
                  </button>
                )}
              </div>
              <p id="verify-file-help" className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {t(
                  'admin.euAiAct.verify.fileHelp',
                  'Images and audio, up to {{mb}} MB. The file is not stored.',
                  {
                    mb: Math.round(maxFileBytes / (1024 * 1024))
                  }
                )}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!hasInput || busy}
              aria-describedby={!hasInput ? 'verify-disabled-reason' : undefined}
              className={BUTTON_PRIMARY}
            >
              {busy && (
                <Icon
                  name="refresh"
                  size="sm"
                  className="animate-spin motion-reduce:animate-none"
                />
              )}
              {busy
                ? t('admin.euAiAct.verify.checking', 'Checking…')
                : t('admin.euAiAct.verify.check', 'Check')}
            </button>
            {!hasInput && (
              <span
                id="verify-disabled-reason"
                className="text-xs text-gray-600 dark:text-gray-400"
              >
                {mode === 'text'
                  ? t('admin.euAiAct.verify.needText', 'Paste a text first.')
                  : t('admin.euAiAct.verify.needFile', 'Choose a file first.')}
              </span>
            )}
          </div>
        </fieldset>
      </form>

      <div role="status" aria-live="polite" aria-busy={busy} className="mt-4">
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {outcome && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{headline}</p>
            <dl className="mt-3 grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-3 text-sm">
              {outcome.rows.map(row => {
                const badge = ROW_BADGE[row.status];
                const { word, text: sentence } = describeRow(row, t);
                return (
                  <div key={row.id} className="contents" data-verify-row={row.id}>
                    <dt className="font-medium text-gray-900 dark:text-gray-100">
                      {rowTitle(row, t)}
                    </dt>
                    <dd className="text-gray-800 dark:text-gray-200">
                      <Badge tone={badge.tone} icon={<Icon name={badge.icon} size="sm" />}>
                        {word}
                      </Badge>
                      <span className="block mt-1">{sentence}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
            {outcome.records.length > 0 && (
              <div className="mt-4" data-testid="verify-records">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {outcome.records.length > 1
                    ? t(
                        'admin.euAiAct.verify.recordsTitle',
                        'Provenance records ({{count}}, newest first)',
                        { count: outcome.records.length }
                      )
                    : t('admin.euAiAct.verify.recordTitle', 'Provenance record')}
                </h3>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  {t(
                    'admin.euAiAct.verify.recordHelp',
                    'What this installation stored when it produced the output. It holds a hash, never the content; it names a user only when "Who a record names" is set.'
                  )}
                </p>
                <div className="mt-2 space-y-3">
                  {outcome.records.map(record => (
                    <ProvenanceRecord key={record.output_id} record={record} />
                  ))}
                </div>
              </div>
            )}
            {outcome.caveats.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">
                {outcome.caveats.map(caveat => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </EuAiActCard>
  );
}
