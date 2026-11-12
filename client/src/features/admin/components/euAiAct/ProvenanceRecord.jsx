// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** A value of the record, or a dash; never an invented one. */
const show = value => (value === undefined || value === null || value === '' ? '–' : String(value));

function formatTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function Field({ label, children, mono = false }) {
  return (
    <div className="contents">
      <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className={`m-0 break-all text-gray-900 dark:text-gray-100 ${mono ? 'font-mono' : ''}`}>
        {children}
      </dd>
    </div>
  );
}

/** The model's marking as the record states it; `provider` is a declaration. */
function markingText(watermark, t) {
  if (!watermark || watermark.by === 'none') {
    return t('admin.euAiAct.record.markingNone', 'None');
  }
  const parts = [
    watermark.by === 'ihub'
      ? t('admin.euAiAct.record.markingIhub', 'iHub watermark')
      : t('admin.euAiAct.record.markingProvider', 'Provider (declared)')
  ];
  if (watermark.scheme) parts.push(watermark.scheme);
  if (watermark.key_id) {
    parts.push(t('admin.euAiAct.record.keyId', 'key {{id}}', { id: watermark.key_id }));
  }
  parts.push(
    watermark.applied
      ? t('admin.euAiAct.record.applied', 'applied')
      : t('admin.euAiAct.record.notApplied', 'not applied')
  );
  if (watermark.reason) parts.push(`(${watermark.reason})`);
  return parts.join(', ');
}

/** How the record names the user (`provenance.recordUser` when it was written). */
function userModeText(mode, t) {
  switch (mode) {
    case 'identified':
      return t('admin.euAiAct.record.userIdentified', 'user id');
    case 'pseudonymous':
      return t('admin.euAiAct.record.userPseudonymous', 'hash of the user id');
    case 'anonymous':
      return t('admin.euAiAct.record.userAnonymous', 'secured hash');
    default:
      return String(mode || '–');
  }
}

/** The kind of output; a kind this version does not know is shown as stored. */
function kindText(kind, t) {
  switch (kind || 'text') {
    case 'text':
      return t('admin.euAiAct.record.kindText', 'Text');
    case 'image':
      return t('admin.euAiAct.record.kindImage', 'Image');
    case 'audio':
      return t('admin.euAiAct.record.kindAudio', 'Audio');
    default:
      return String(kind);
  }
}

function yesNo(value, t) {
  if (value === true) return t('common.yes', 'Yes');
  if (value === false) return t('common.no', 'No');
  return '–';
}

/**
 * One stored provenance record, field by field, plus the record as JSON. The
 * record is what the server stored (a hash, never the content); the C2PA part
 * is what the provider's manifest says, with its signature "valid" meaning
 * "intact", never "trusted".
 *
 * @param {Object} props
 * @param {Object} props.record - A record of `POST /api/eu-ai-act/provenance/_verify`
 */
export default function ProvenanceRecord({ record }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(record, null, 2);
  const c2pa = record.provider_marking?.c2pa;
  const hash = record.content_hash;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available (insecure context): the JSON stays selectable.
    }
  };

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <dl
        className="m-0 grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1.5 text-sm"
        data-testid="provenance-record"
      >
        <Field label={t('admin.euAiAct.record.outputId', 'Output ID')} mono>
          {show(record.output_id)}
        </Field>
        <Field label={t('admin.euAiAct.record.created', 'Created')}>
          {formatTime(record.created_at)}
        </Field>
        <Field label={t('admin.euAiAct.record.model', 'Model')}>{show(record.model?.id)}</Field>
        {record.user?.id && (
          <Field label={t('admin.euAiAct.record.user', 'User')} mono>
            {record.user.id}{' '}
            <span className="font-sans text-gray-600 dark:text-gray-400">
              ({userModeText(record.user.mode, t)})
            </span>
          </Field>
        )}
        <Field label={t('admin.euAiAct.record.kind', 'Kind')}>{kindText(record.kind, t)}</Field>
        <Field label={t('admin.euAiAct.record.marking', 'Model marking')}>
          {markingText(record.model?.watermark, t)}
        </Field>
        <Field label={t('admin.euAiAct.record.generator', 'Generator')}>
          {[record.generator?.product, record.generator?.version].filter(Boolean).join(' ') || '–'}
        </Field>
        <Field label={t('admin.euAiAct.record.installation', 'Installation')} mono>
          {show(record.generator?.installation_id)}
        </Field>
        <Field label={t('admin.euAiAct.record.hash', 'Content hash')} mono>
          {hash ? `${show(hash.alg)} (${show(hash.normalization)}): ${show(hash.value)}` : '–'}
        </Field>
        {hash?.mime_type && (
          <Field label={t('admin.euAiAct.record.file', 'File')}>
            {hash.mime_type}
            {hash.bytes
              ? `, ${t('admin.euAiAct.record.bytes', '{{formatted}} bytes', {
                  formatted: hash.bytes.toLocaleString()
                })}`
              : ''}
          </Field>
        )}
        {record.provider_marking && (
          <>
            <Field label={t('admin.euAiAct.record.declared', 'Declared by the operator')}>
              {show(record.provider_marking.declared)}
            </Field>
            <Field label={t('admin.euAiAct.record.c2pa', 'C2PA manifest at generation')}>
              {c2pa?.present
                ? t('admin.euAiAct.record.c2paPresent', 'present')
                : c2pa?.status === 'absent'
                  ? t('admin.euAiAct.record.c2paAbsent', 'absent')
                  : show(c2pa?.status)}
            </Field>
            {c2pa?.present && (
              <>
                <Field label={t('admin.euAiAct.record.c2paSigner', 'Signed by')}>
                  {show(c2pa.issuer)}
                </Field>
                <Field label={t('admin.euAiAct.record.c2paSignedAt', 'Signed at')}>
                  {formatTime(c2pa.signedAt)}
                </Field>
                <Field label={t('admin.euAiAct.record.c2paGenerator', 'Claim generator')}>
                  {show(c2pa.claimGenerator)}
                </Field>
                <Field label={t('admin.euAiAct.record.c2paSource', 'Digital source type')}>
                  {show(c2pa.digitalSourceType)}
                </Field>
                <Field label={t('admin.euAiAct.record.c2paValid', 'Signature intact')}>
                  {yesNo(c2pa.valid, t)}{' '}
                  <span className="text-gray-600 dark:text-gray-400">
                    {t('admin.euAiAct.record.trustNotEvaluated', '(trust not evaluated)')}
                  </span>
                </Field>
              </>
            )}
            {record.provider_marking.xmp?.digitalSourceType && (
              <Field label={t('admin.euAiAct.record.xmp', 'XMP digital source type')}>
                {record.provider_marking.xmp.digitalSourceType}
              </Field>
            )}
          </>
        )}
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-indigo-700 dark:text-indigo-300">
          {t('admin.euAiAct.record.json', 'Show the record as JSON')}
        </summary>
        <div className="mt-2">
          <button
            type="button"
            onClick={copy}
            className="text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:underline"
          >
            {copied
              ? t('admin.euAiAct.record.copied', 'Copied')
              : t('admin.euAiAct.record.copy', 'Copy JSON')}
          </button>
          <pre
            className="mt-1 max-h-80 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-3 text-xs text-gray-900 dark:text-gray-100"
            data-testid="provenance-record-json"
          >
            {json}
          </pre>
        </div>
      </details>
    </div>
  );
}
