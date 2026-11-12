// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { usePopoverPanel } from '../hooks/usePopoverPanel';

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
 * proves. Shared by the button on a generated image and by the "Details" of an
 * answer's "About this answer" popover.
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

/**
 * "AI generated" information on a generated image (EU AI Act Art. 50(2)): which
 * model produced it, when, and the hash of its file, from the provenance object
 * the server attached (an image's `provenance`). Nothing is inferred here. An
 * output without the object shows no button. The details of an answer's text
 * are part of the answer's "About this answer" popover (`AnswerBasis`).
 *
 * @param {Object} props
 * @param {Object} props.provenance - The server's provenance object
 * @param {Array<Object>} [props.models] - Model list, for the model's display name
 * @param {'top'|'bottom'} [props.placement='top'] - Where the panel prefers to open; it
 *   opens on the other side when the preferred one has no room
 * @param {string} [props.buttonClassName] - Replaces the button's look (on an image)
 */
function ProvenanceInfo({ provenance, models, placement = 'top', buttonClassName }) {
  const { t } = useTranslation();
  const { open, setOpen, side, panelStyle, panelId, rootRef, buttonRef, panelRef } =
    usePopoverPanel(placement);

  if (!provenance?.ai_generated) return null;

  const isImage = provenance.kind === 'image';
  const label = isImage
    ? t('chatMessage.provenance.imageButton', 'AI-generated image: details')
    : t('chatMessage.provenance.button', 'AI generated: details');

  return (
    <div className="relative inline-flex" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        data-testid="provenance-button"
        className={
          buttonClassName ||
          'inline-flex items-center justify-center min-h-6 min-w-6 rounded-full border border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'
        }
      >
        <Icon name="information-circle" className="w-4 h-4" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          style={panelStyle}
          role="dialog"
          aria-label={t('chatMessage.provenance.title', 'AI generated')}
          data-testid="provenance-panel"
          className={`absolute ${side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'} end-0 z-20 w-72 max-h-[70vh] overflow-y-auto max-w-[85vw] rounded-lg border border-gray-200 bg-white p-3 text-start text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900`}
        >
          <p className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {isImage
              ? t('chatMessage.provenance.imageTitle', 'AI-generated image')
              : t('chatMessage.provenance.title', 'AI generated')}
          </p>
          <ProvenanceDetails provenance={provenance} models={models} />
        </div>
      )}
    </div>
  );
}

export default ProvenanceInfo;
