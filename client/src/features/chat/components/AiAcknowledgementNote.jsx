// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { useAiAcknowledgement } from '../../../shared/hooks/useAiAcknowledgement';

/**
 * Polite note above the composer after the user closed the AI-use dialog
 * without confirming: sending is blocked until they do, and the button opens
 * the dialog again. Nothing is lost: the draft stays in the composer.
 */
function AiAcknowledgementNote({
  className = 'mx-auto mb-2 max-w-3xl px-4 text-sm text-gray-700 dark:text-gray-300'
}) {
  const { t } = useTranslation();
  const acknowledgement = useAiAcknowledgement();
  if (!acknowledgement?.declined || !acknowledgement.pending) return null;
  return (
    <p role="status" data-testid="ai-ack-note" className={className}>
      {t('aiAcknowledgement.composerNote', 'Please confirm the AI-use notice to send messages.')}{' '}
      <button
        type="button"
        onClick={() => acknowledgement.review()}
        className="font-medium text-indigo-700 dark:text-indigo-300 underline underline-offset-2"
      >
        {t('aiAcknowledgement.review', 'Review notice')}
      </button>
    </p>
  );
}

export default AiAcknowledgementNote;
