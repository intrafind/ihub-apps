// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchChatArtifactProvenance } from '../../../api';
import { useArtifactProvenanceFetcher } from '../contexts/ArtifactProvenanceFetchContext';
import { Row } from './ProvenanceInfo';

/**
 * What the provider embedded in a stored image, asked for when its details are opened
 * (EU AI Act Art. 50(2)). The server reads the file's Content Credentials (C2PA) when
 * the picture is generated, after it has been sent, so the chat asks for the result
 * afterwards. No record, a failed request or a picture not stored yet (no artifact id)
 * is "nothing to show", never an error in the panel.
 *
 * @param {string|undefined} chatId - Chat the artifact belongs to
 * @param {string|undefined} artifactId - Stored artifact id of the picture
 * @returns {Object|null} `{ outputId, createdAt?, providerMarking }`, or null
 */
export function useProviderMark(chatId, artifactId) {
  const customFetch = useArtifactProvenanceFetcher();
  // Keyed by what it answers, so an answer for another picture is never shown.
  const [loaded, setLoaded] = useState({ key: null, mark: null });
  const key = chatId && artifactId ? `${chatId}:${artifactId}` : null;

  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    (customFetch || fetchChatArtifactProvenance)(chatId, artifactId)
      .then(mark => {
        if (active) setLoaded({ key, mark });
      })
      .catch(() => {
        // Nothing recorded for it (or records are off): the panel simply has no row.
      });
    return () => {
      active = false;
    };
  }, [key, chatId, artifactId, customFetch]);

  return loaded.key === key ? loaded.mark : null;
}

/** An IPTC digital source type as a person reads it; the raw value when it is none we know. */
function sourceTypeLabel(uri, t) {
  const value = String(uri || '');
  if (/trainedAlgorithmicMedia/i.test(value)) {
    return t('chatMessage.provenance.providerMark.sourceAi', 'Created by an AI model');
  }
  if (/algorithmicMedia/i.test(value)) {
    return t('chatMessage.provenance.providerMark.sourceAlgorithmic', 'Created by software');
  }
  return value.split('/').filter(Boolean).pop() || value;
}

const STATUS_TEXT = {
  present: ['found', 'Found in the file'],
  absent: ['absent', 'None in the file'],
  unreadable: ['unreadable', 'Found in the file, but could not be read'],
  unsupported_format: ['unsupported', 'This file type cannot be checked']
};

/**
 * The rows of a picture's embedded provider mark: the Content Credentials (C2PA) the
 * file carries and what they say. Worded as the server's reader promises: the signature
 * matches the file or not, and whether the signer is trusted is not evaluated. Nothing
 * here says the picture is authentic, and no result says it is not AI-generated.
 *
 * Renders rows for a `<dl>` (`ProvenanceDetails`); nothing until the answer is in.
 *
 * @param {Object} props
 * @param {string} [props.chatId]
 * @param {string} [props.artifactId]
 */
function ProviderMark({ chatId, artifactId }) {
  const { t, i18n } = useTranslation();
  const mark = useProviderMark(chatId, artifactId);
  const c2pa = mark?.providerMarking?.c2pa;
  if (!c2pa) return null;

  const [statusKey, statusFallback] = STATUS_TEXT[c2pa.status] || STATUS_TEXT.unreadable;
  const signedAt = c2pa.signedAt ? new Date(c2pa.signedAt) : null;
  const signed =
    signedAt && !Number.isNaN(signedAt.getTime()) ? signedAt.toLocaleString(i18n?.language) : null;
  const xmpSource = mark.providerMarking.xmp?.digitalSourceType;

  return (
    <>
      <Row label={t('chatMessage.provenance.providerMark.title', 'Content Credentials (C2PA)')}>
        <span data-testid="provider-mark-status">
          {t(`chatMessage.provenance.providerMark.status.${statusKey}`, statusFallback)}
        </span>
        {c2pa.present && c2pa.valid === true && (
          <span className="block">
            {t(
              'chatMessage.provenance.providerMark.signatureOk',
              'The signature matches the file.'
            )}
          </span>
        )}
        {c2pa.present && c2pa.valid === false && (
          <span className="block" data-testid="provider-mark-invalid">
            {t(
              'chatMessage.provenance.providerMark.signatureBad',
              'The signature does not match the file: it was changed or damaged.'
            )}
          </span>
        )}
        {c2pa.present && (
          <span className="mt-1 block text-gray-500 dark:text-gray-400">
            {t(
              'chatMessage.provenance.providerMark.trustNote',
              'iHub does not check whether the signer is trusted.'
            )}
          </span>
        )}
      </Row>
      {c2pa.issuer && (
        <Row label={t('chatMessage.provenance.providerMark.signer', 'Signed by')}>
          {c2pa.issuer}
        </Row>
      )}
      {c2pa.claimGenerator && (
        <Row label={t('chatMessage.provenance.providerMark.tool', 'Created with')}>
          {c2pa.claimGenerator}
        </Row>
      )}
      {signed && (
        <Row label={t('chatMessage.provenance.providerMark.signedAt', 'Signed')}>{signed}</Row>
      )}
      {c2pa.digitalSourceType && (
        <Row label={t('chatMessage.provenance.providerMark.source', 'Source type')}>
          {sourceTypeLabel(c2pa.digitalSourceType, t)}
        </Row>
      )}
      {!c2pa.present && xmpSource && (
        <Row label={t('chatMessage.provenance.providerMark.metadata', 'Embedded metadata')}>
          {sourceTypeLabel(xmpSource, t)}
        </Row>
      )}
    </>
  );
}

export default ProviderMark;
