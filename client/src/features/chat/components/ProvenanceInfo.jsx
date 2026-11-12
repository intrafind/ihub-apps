// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';

/** The first and last characters of a hash, so it fits a narrow popover. */
const shortHash = value =>
  typeof value === 'string' && value.length > 20
    ? `${value.slice(0, 10)}…${value.slice(-8)}`
    : value;

/**
 * What the model declares about marking its output, in words that claim no more
 * than the server's record does: a provider mark is the operator's statement, not
 * something iHub checked.
 */
function markingLabel(watermark, t) {
  if (watermark?.by === 'provider') {
    return t('chatMessage.provenance.markingProvider', 'Marked by the provider (declared)');
  }
  if (watermark?.by === 'ihub' && watermark.applied === true) {
    return t('chatMessage.provenance.markingIhub', 'iHub watermark');
  }
  return t('chatMessage.provenance.markingNone', 'Not marked by the model');
}

/**
 * The model as a person reads it: its display name from the model list with the
 * id the server recorded, or the id alone when the model is not in the list (a
 * deleted model, a workflow `workflow:<id>`).
 */
function modelLabel(modelId, models, language) {
  if (!modelId) return '–';
  const model = Array.isArray(models) ? models.find(m => m?.id === modelId) : null;
  const name = model ? getLocalizedContent(model.name, language) : '';
  return name && name !== modelId ? `${name} (${modelId})` : modelId;
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="m-0 break-all text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

/**
 * The record of an AI-generated output as a list: which model produced it, when,
 * the marking and the hash of its text or file, with the note on what the hash
 * proves. Rendered in the "Details" of an answer's "About this answer" popover, for
 * the answer's text and for each picture it produced (EU AI Act Art. 50(2)): one place
 * for all of it, the chip under the answer. Nothing is inferred here; an output without
 * the server's object has no record to show.
 *
 * @param {Object} props
 * @param {Object} props.provenance - The server's provenance object
 * @param {Array<Object>} [props.models] - Model list, for the model's display name
 */
export function ProvenanceDetails({ provenance, models }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isImage = provenance?.kind === 'image';
  const hash = provenance?.content_hash?.value;
  const createdAt = provenance?.created_at ? new Date(provenance.created_at) : null;
  const created =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? createdAt.toLocaleString(i18n?.language)
      : null;

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available (insecure context): the hash stays selectable in the panel.
    }
  };

  return (
    <>
      <dl className="m-0 flex flex-col gap-2">
        <Row label={t('chatMessage.provenance.model', 'Model')}>
          <span data-testid="provenance-model">
            {modelLabel(provenance.model?.id, models, i18n?.language)}
          </span>
        </Row>
        {created && <Row label={t('chatMessage.provenance.created', 'Created')}>{created}</Row>}
        <Row label={t('chatMessage.provenance.marking', 'Marking')}>
          {markingLabel(provenance.model?.watermark, t)}
        </Row>
        {hash && (
          <Row label={t('chatMessage.provenance.hash', 'Content hash (SHA-256)')}>
            {/* Shortened to fit a narrow panel; the full hash is read out and copied. */}
            <span data-testid="provenance-hash" title={hash}>
              <span aria-hidden="true">{shortHash(hash)}</span>
              <span className="sr-only">{hash}</span>
            </span>
            <button
              type="button"
              onClick={copyHash}
              className="ms-2 text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {copied
                ? t('chatMessage.provenance.copied', 'Copied')
                : t('chatMessage.provenance.copyHash', 'Copy hash')}
            </button>
          </Row>
        )}
        {provenance.output_id && (
          <Row label={t('chatMessage.provenance.outputId', 'Output ID')}>
            {provenance.output_id}
          </Row>
        )}
      </dl>
      <p className="mt-2 text-gray-500 dark:text-gray-400">
        {isImage
          ? t(
              'chatMessage.provenance.imageNote',
              'The provenance record keeps this hash, not the image itself. The unchanged file can be checked with it. Any marks the provider embedded are kept. No match does not mean a person made it.'
            )
          : t(
              'chatMessage.provenance.note',
              'iHub keeps this hash, not the text. The exact text can be looked up with it. No match does not mean a person wrote it.'
            )}
      </p>
    </>
  );
}
