// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-4 py-2 text-sm font-medium rounded-md focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-gray-800';

/**
 * Shows a secret exactly once (a new or rotated OAuth client secret, an API
 * key) and helps the admin store it. Replaces `window.alert(secret)`, which
 * had no Copy button and could not be translated (ID-B15).
 *
 *   - The secret sits in a read-only monospace field (selectable) with a Copy
 *     button that announces "Copied".
 *   - "This is the only time the secret is shown. Store it now." is always visible.
 *   - Done closes. Done, Escape or a backdrop click before the secret was
 *     copied first shows an inline warning; the second attempt closes.
 *   - The secret is never logged or written anywhere but the clipboard (on
 *     request). Callers keep it in component state only and drop it in `onDone`.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the dialog is shown.
 * @param {string} props.title - Heading, e.g. "New secret for "Reporting bot"".
 * @param {string} props.secret - The secret to show.
 * @param {string} [props.fieldLabel] - Label of the field (default "Secret").
 * @param {React.ReactNode} [props.description] - Extra text above the field.
 * @param {() => void} props.onDone - Called when the dialog closes; drop the secret here.
 * @returns {JSX.Element|null}
 *
 * @example
 * <SecretRevealDialog
 *   isOpen={Boolean(revealed)}
 *   title={t('admin.auth.oauth.secretReveal.title', { name: revealed?.name })}
 *   secret={revealed?.secret || ''}
 *   onDone={() => setRevealed(null)}
 * />
 */
function SecretRevealDialog({ isOpen, ...props }) {
  // Mounted only while open: each reveal starts fresh, and the secret leaves
  // the component tree when the dialog closes.
  if (!isOpen) return null;
  return <SecretRevealPanel {...props} />;
}

/**
 * The open dialog. See {@link SecretRevealDialog} for the props.
 *
 * @param {Object} props
 * @returns {JSX.Element}
 */
function SecretRevealPanel({ title, secret, fieldLabel, description, onDone }) {
  const { t } = useTranslation();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const fieldId = `${baseId}-secret`;
  const fieldRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [warned, setWarned] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyFailed(false);
      setWarned(false);
    } catch {
      setCopyFailed(true);
      fieldRef.current?.select();
    }
  };

  /** Done, Escape and backdrop: warn once while the secret was never copied. */
  const attemptClose = () => {
    if (!copied && !warned) {
      setWarned(true);
      return;
    }
    onDone();
  };

  return (
    <Modal isOpen onClose={attemptClose} labelledBy={titleId} initialFocusRef={fieldRef}>
      <div className="p-6">
        <h2
          id={titleId}
          className="text-lg font-semibold text-gray-900 dark:text-white break-words"
        >
          {title}
        </h2>
        {description && (
          <div className="mt-2 text-sm text-gray-600 dark:text-gray-300">{description}</div>
        )}
        <p className="mt-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200">
          {t(
            'common.secretReveal.onlyOnce',
            'This is the only time the secret is shown. Store it now.'
          )}
        </p>
        <label
          htmlFor={fieldId}
          className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {fieldLabel || t('common.secretReveal.fieldLabel', 'Secret')}
        </label>
        <div className="flex gap-2">
          <input
            ref={fieldRef}
            id={fieldId}
            type="text"
            readOnly
            value={secret}
            autoComplete="off"
            spellCheck={false}
            onFocus={event => event.target.select()}
            className="w-full min-w-0 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm font-mono focus:outline-hidden focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="button"
            onClick={handleCopy}
            className={`${BUTTON_CLASS} shrink-0 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600`}
          >
            {t('common.copy', 'Copy')}
          </button>
        </div>
        <p role="status" className="mt-1 min-h-[1.25rem] text-xs text-gray-600 dark:text-gray-400">
          {copied ? t('common.secretReveal.copied', 'Copied') : ''}
          {copyFailed
            ? t('common.secretReveal.copyFailed', "Couldn't copy. Select the text and copy it.")
            : ''}
        </p>
        {warned && !copied && (
          <div
            role="alert"
            className="mt-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200"
          >
            {t(
              'common.secretReveal.notCopiedWarning',
              "You haven't copied the secret yet. Close anyway?"
            )}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
        <button
          type="button"
          onClick={attemptClose}
          className={`${BUTTON_CLASS} text-white bg-indigo-600 hover:bg-indigo-700`}
        >
          {warned && !copied
            ? t('common.secretReveal.closeAnyway', 'Close anyway')
            : t('common.done', 'Done')}
        </button>
      </div>
    </Modal>
  );
}

export default SecretRevealDialog;
