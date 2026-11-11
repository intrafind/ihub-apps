// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';

const FOCUS_RING = {
  indigo:
    'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800',
  slate:
    'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800'
};

const PRIMARY = {
  indigo: 'text-white bg-indigo-600 hover:bg-indigo-700',
  slate:
    'text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
};
const SECONDARY = {
  indigo:
    'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600',
  slate:
    'border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600'
};

function buttonClass(kind, tone, compact) {
  return [
    'px-4 py-2 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed',
    // Touch targets stay 44 px even where the root font is 13 px (Outlook pane).
    compact ? 'min-h-[44px]' : 'min-h-11',
    // Windows high contrast: never rely on fills alone to mark a button.
    'forced-colors:border forced-colors:border-[CanvasText]',
    FOCUS_RING[tone],
    (kind === 'primary' ? PRIMARY : SECONDARY)[tone]
  ].join(' ');
}

/** Only http(s) addresses are linked; anything else is dropped, never rendered as a link. */
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Blocking dialog of the AI-use acknowledgement (#3326). Presentational: the
 * provider (`AiAcknowledgementContext`) owns the state and the requests.
 *
 * One component for every host (web, Teams, Nextcloud, embeds, the Outlook
 * pane and the extension side panel). A host only changes how it looks and how
 * the policy opens:
 * - `tone`: `indigo` (web) or `slate` (Office pane, extension);
 * - `compact`: smaller paddings for a narrow pane or a short frame;
 * - `openPolicy(url) => Promise<boolean>`: how the host opens the policy; when
 *   it answers false (or `showPolicyAddress`) the address is shown to copy;
 *   without it the plain `target=_blank` link works as it always did;
 * - `readOnly`: "AI-use notice" opened later, after confirming: text and Close.
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
  loadFailed = false,
  cookieBlocked = false,
  readOnly = false,
  tone = 'indigo',
  compact = false,
  openPolicy,
  showPolicyAddress = false,
  onConfirm,
  onCancel,
  onSkip,
  onRetryLoad,
  onOpenInBrowser
}) {
  const { t } = useTranslation();
  const titleRef = useRef(null);
  const [policyBlocked, setPolicyBlocked] = useState(false);
  const [copied, setCopied] = useState(false);
  const failed = loadFailed && !notice;
  if (!isOpen || (!notice && !failed)) return null;

  const paragraphs = String(notice?.text || '')
    .split(/\n{2,}/)
    .filter(part => part.trim() !== '');
  const policyUrl = notice?.policyUrl && isHttpUrl(notice.policyUrl) ? notice.policyUrl : '';
  const addressShown = Boolean(policyUrl) && (showPolicyAddress || policyBlocked);
  const slate = tone === 'slate';
  const pad = compact ? 'px-4' : 'px-6';

  const handlePolicyClick = async event => {
    if (!openPolicy) return; // the anchor's own target=_blank
    event.preventDefault();
    let opened = false;
    try {
      opened = await openPolicy(policyUrl);
    } catch {
      opened = false;
    }
    setPolicyBlocked(!opened);
  };

  const handleCopy = async () => {
    if (await copyText(policyUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const textColor = slate
    ? 'text-slate-700 dark:text-slate-200'
    : 'text-gray-700 dark:text-gray-300';
  const mutedColor = slate
    ? 'text-slate-500 dark:text-slate-400'
    : 'text-gray-500 dark:text-gray-400';

  return (
    <Modal
      isOpen
      onClose={onCancel}
      maxWidthClassName="max-w-lg"
      closeOnBackdropClick={false}
      initialFocusRef={titleRef}
      labelledBy="ai-ack-title"
      overlayPaddingClassName={compact ? 'p-2' : 'p-4'}
      maxHeightClassName={compact ? 'max-h-[96dvh]' : 'max-h-[90vh]'}
      surfaceClassName={
        slate
          ? 'bg-white dark:bg-slate-800 forced-colors:border forced-colors:border-[CanvasText]'
          : 'bg-white dark:bg-gray-800 forced-colors:border forced-colors:border-[CanvasText]'
      }
    >
      <div aria-busy={submitting} className="flex flex-col min-h-0 flex-1">
        <div className={`${pad} pt-4 sm:pt-6 flex items-center gap-3`}>
          <div
            className={`${compact ? 'w-8 h-8' : 'w-10 h-10'} shrink-0 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center`}
          >
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
            className={`text-lg font-semibold text-balance ${slate ? 'text-slate-900 dark:text-white' : 'text-gray-900 dark:text-white'} focus:outline-hidden`}
          >
            {t('aiAcknowledgement.title', 'Confirm your use of AI')}
          </h2>
        </div>

        <div
          role="region"
          aria-labelledby="ai-ack-title"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard focusable
          tabIndex={0}
          className={`${pad} py-3 text-sm leading-6 ${textColor} overflow-y-auto min-h-0 max-h-[50vh] break-words focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-hidden`}
        >
          {failed && (
            <p role="alert" className="mb-3 font-medium">
              {t(
                'aiAcknowledgement.loadFailed',
                'The notice could not be loaded. Check your connection and try again.'
              )}
            </p>
          )}
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
          {policyUrl && (
            <p className="mb-3">
              <a
                href={policyUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handlePolicyClick}
                className="inline-flex flex-wrap items-center gap-1 text-indigo-700 dark:text-indigo-300 underline"
              >
                {t('aiAcknowledgement.policyLink', 'Read the AI policy')}
                <Icon name="external-link" size="sm" />
                <span className="sr-only">
                  {openPolicy
                    ? t('aiAcknowledgement.opensInBrowser', '(opens in your browser)')
                    : t('aiAcknowledgement.opensInNewTab', '(opens in a new tab)')}
                </span>
              </a>
            </p>
          )}
          {addressShown && (
            <div
              data-testid="ai-ack-policy-address"
              className={`mb-3 rounded-md border px-3 py-2 text-xs ${slate ? 'border-slate-200 dark:border-slate-700' : 'border-gray-200 dark:border-gray-700'}`}
            >
              {policyBlocked && (
                <p className="mb-1" role="status">
                  {t(
                    'aiAcknowledgement.policyBlocked',
                    'The policy could not be opened. Copy the address and open it in your browser.'
                  )}
                </p>
              )}
              <span className="block select-all font-mono [overflow-wrap:anywhere]">
                {policyUrl}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className={`mt-2 rounded-md border px-2 py-1 text-xs font-medium ${slate ? 'border-slate-300 dark:border-slate-600' : 'border-gray-300 dark:border-gray-600'} ${FOCUS_RING[tone]}`}
              >
                {copied
                  ? t('common.copied', 'Copied!')
                  : t('aiAcknowledgement.copyAddress', 'Copy address')}
              </button>
            </div>
          )}
          {cookieBlocked && (
            <p role="alert" className="mb-3 font-medium">
              {t(
                'aiAcknowledgement.cookieBlocked',
                'Your browser blocks cookies in this frame, so the confirmation cannot be kept here. Open iHub in its own tab to confirm.'
              )}
            </p>
          )}
          {anonymous && !readOnly && (
            <p className={mutedColor}>
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
            className={`${compact ? 'mx-4' : 'mx-6'} mb-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-800 dark:text-red-200`}
          >
            {t(
              'aiAcknowledgement.error',
              'Your confirmation could not be saved. Your message is still here. Try again.'
            )}
          </p>
        )}

        <div
          className={`shrink-0 border-t ${slate ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/30' : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30'} ${pad} py-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3`}
        >
          {readOnly ? (
            <button
              type="button"
              onClick={onCancel}
              className={buttonClass('primary', tone, compact)}
            >
              {t('common.close', 'Close')}
            </button>
          ) : (
            <>
              {enforce || failed ? (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  className={buttonClass('secondary', tone, compact)}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={submitting}
                  className={buttonClass('secondary', tone, compact)}
                >
                  {t('aiAcknowledgement.skip', 'Continue without confirming')}
                </button>
              )}
              {cookieBlocked && onOpenInBrowser && (
                <button
                  type="button"
                  onClick={onOpenInBrowser}
                  className={buttonClass('primary', tone, compact)}
                >
                  {t('aiAcknowledgement.openInBrowser', 'Open iHub in the browser')}
                </button>
              )}
              {failed ? (
                <button
                  type="button"
                  onClick={onRetryLoad}
                  className={buttonClass('primary', tone, compact)}
                >
                  {t('aiAcknowledgement.retry', 'Try again')}
                </button>
              ) : (
                !cookieBlocked && (
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={submitting}
                    className={buttonClass('primary', tone, compact)}
                  >
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
                )
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default AiAcknowledgementDialog;
