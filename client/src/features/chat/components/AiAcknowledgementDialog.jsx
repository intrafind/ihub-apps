// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';

const PRIMARY =
  'px-4 py-2 min-h-11 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY =
  'px-4 py-2 min-h-11 rounded-lg font-medium border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Blocking dialog of the AI-use acknowledgement (#3326). Presentational: the
 * provider (`AiAcknowledgementContext`) owns the state and the requests.
 *
 * The text is the admin's plain text, rendered as text, never as HTML. Focus
 * starts on the heading so a screen reader reads the text before reaching
 * Confirm; Escape and Cancel close it without sending anything.
 */
function AiAcknowledgementDialog({
  isOpen,
  notice,
  enforce = true,
  hasPendingMessage = false,
  submitting = false,
  error = false,
  stale = false,
  anonymous = false,
  onConfirm,
  onCancel,
  onSkip
}) {
  const { t } = useTranslation();
  const titleRef = useRef(null);
  if (!isOpen || !notice) return null;

  const paragraphs = String(notice.text || '')
    .split(/\n{2,}/)
    .filter(part => part.trim() !== '');

  return (
    <Modal
      isOpen
      onClose={onCancel}
      maxWidthClassName="max-w-lg"
      closeOnBackdropClick={false}
      initialFocusRef={titleRef}
      labelledBy="ai-ack-title"
    >
      <div aria-busy={submitting} className="flex flex-col min-h-0">
        <div className="px-6 pt-6 flex items-center gap-3">
          <div className="w-10 h-10 shrink-0 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
            <Icon
              name="information-circle"
              size="md"
              className="text-indigo-700 dark:text-indigo-300"
            />
          </div>
          <h2
            id="ai-ack-title"
            ref={titleRef}
            tabIndex={-1}
            className="text-lg font-semibold text-gray-900 dark:text-white focus:outline-hidden"
          >
            {t('aiAcknowledgement.title', 'Confirm your use of AI')}
          </h2>
        </div>

        <div
          role="region"
          aria-labelledby="ai-ack-title"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard focusable
          tabIndex={0}
          className="px-6 py-4 text-sm leading-6 text-gray-700 dark:text-gray-300 overflow-y-auto max-h-[50vh]"
        >
          {stale && (
            <p className="mb-3 font-medium" role="status">
              {t(
                'aiAcknowledgement.stale',
                'The notice was updated. Please read it and confirm again.'
              )}
            </p>
          )}
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="mb-3 whitespace-pre-line">
              {paragraph}
            </p>
          ))}
          {notice.policyUrl && (
            <p className="mb-3">
              <a
                href={notice.policyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-700 dark:text-indigo-300 underline"
              >
                {t('aiAcknowledgement.policyLink', 'Read the AI policy')}
                <Icon name="external-link" size="sm" />
                <span className="sr-only">
                  {t('aiAcknowledgement.opensInNewTab', '(opens in a new tab)')}
                </span>
              </a>
            </p>
          )}
          {anonymous && (
            <p className="text-gray-500 dark:text-gray-400">
              {t(
                'aiAcknowledgement.anonymousNote',
                'This confirmation is remembered in this browser for up to 30 days.'
              )}
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="mx-6 mb-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-800 dark:text-red-200"
          >
            {t(
              'aiAcknowledgement.error',
              'Your confirmation could not be saved. Your message is still here. Try again.'
            )}
          </p>
        )}

        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 px-6 py-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          {enforce ? (
            <button type="button" onClick={onCancel} disabled={submitting} className={SECONDARY}>
              {t('common.cancel', 'Cancel')}
            </button>
          ) : (
            <button type="button" onClick={onSkip} disabled={submitting} className={SECONDARY}>
              {t('aiAcknowledgement.skip', 'Continue without confirming')}
            </button>
          )}
          <button type="button" onClick={onConfirm} disabled={submitting} className={PRIMARY}>
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <svg
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    opacity="0.25"
                  />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" />
                </svg>
                {t('aiAcknowledgement.saving', 'Saving...')}
              </span>
            ) : error ? (
              t('aiAcknowledgement.retry', 'Try again')
            ) : hasPendingMessage ? (
              t('aiAcknowledgement.confirmAndSend', 'Confirm and send')
            ) : (
              t('aiAcknowledgement.confirm', 'I understand')
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default AiAcknowledgementDialog;
