// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';

/** The key is shown for this long, then removed from the page. */
export const KEY_AUTO_HIDE_MS = 60_000;

const BUTTON_PRIMARY =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800';
const BUTTON_SECONDARY =
  'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-indigo-500';
const INPUT =
  'block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs sm:text-sm focus:ring-indigo-500 focus:border-indigo-500';
const SECRET_BLOCK =
  'font-mono text-xs break-all whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-md p-3 select-all';

export { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT };

/** Select the text of an element so Ctrl+C works when the clipboard API is not available. */
function selectContents(element) {
  if (!element) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A copy button for a secret. Plain-HTTP admin URLs have no clipboard API, so a
 * failed copy selects the text and says so. Never logs or toasts the value.
 */
function CopyButton({ label, getText, targetRef, id }) {
  const { t } = useTranslation();
  const [state, setState] = useState('idle');
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setState('copied');
    } catch {
      selectContents(targetRef?.current);
      setState('failed');
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), 3000);
  };
  return (
    <>
      <button type="button" id={id} onClick={copy} className={BUTTON_SECONDARY}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size="sm" />
        {state === 'copied' ? t('common.copied', 'Copied') : label}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied' && t('admin.euAiAct.keys.copied', 'Copied to clipboard')}
        {state === 'failed' &&
          t('admin.euAiAct.keys.copyFailed', 'Copy failed. The text is selected: press Ctrl+C.')}
      </span>
      {state === 'failed' && (
        <span className="text-xs text-amber-800 dark:text-amber-300" aria-hidden="true">
          {t('admin.euAiAct.keys.copyFailed', 'Copy failed. The text is selected: press Ctrl+C.')}
        </span>
      )}
    </>
  );
}

/**
 * Shows a key and its vLLM snippet, after "Generate", "Add" or "Reveal".
 *
 * The key is in the DOM only while visible: after {@link KEY_AUTO_HIDE_MS} (or
 * when `secret` is null) the dialog shows a "Reveal again" button instead. It
 * is never put in a live region, storage or URL, and the parent drops it on close.
 *
 * @param {Object} props
 * @param {{keyId: string, key: string|null, vllmConfigSnippet: string|null, weakKey?: boolean, generated: boolean}|null} props.shown
 * @param {() => void} props.onClose
 * @param {() => void} props.onHide - The timer ran out: parent clears the secret
 * @param {() => void} props.onRevealAgain
 * @param {number} [props.autoHideMs]
 */
export function KeyShownDialog({
  shown,
  onClose,
  onHide,
  onRevealAgain,
  autoHideMs = KEY_AUTO_HIDE_MS
}) {
  const { t } = useTranslation();
  const titleRef = useRef(null);
  const keyRef = useRef(null);
  const snippetRef = useRef(null);
  const visible = Boolean(shown?.key);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(onHide, autoHideMs);
    return () => clearTimeout(timer);
  }, [visible, onHide, autoHideMs, shown?.keyId]);

  if (!shown) return null;
  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      closeOnBackdropClick={false}
      initialFocusRef={titleRef}
      labelledBy="watermark-key-dialog-title"
    >
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2
          id="watermark-key-dialog-title"
          ref={titleRef}
          tabIndex={-1}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden"
        >
          {shown.generated
            ? t('admin.euAiAct.keys.dialogNew', 'New watermark key {{keyId}}', {
                keyId: shown.keyId
              })
            : t('admin.euAiAct.keys.dialogReveal', 'Watermark key {{keyId}}', {
                keyId: shown.keyId
              })}
        </h2>
      </div>
      <div className="px-6 py-4 space-y-4 overflow-y-auto">
        <div className="flex gap-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-3 text-sm text-amber-900 dark:text-amber-200">
          <Icon name="exclamation-triangle" size="sm" className="shrink-0 mt-0.5" />
          <p>
            {t(
              'admin.euAiAct.keys.callout',
              'Update vLLM with this key, then run the self-test. Showing a key is written to the audit log. Anyone with this key can forge or strip the watermark: do not paste it into tickets or chats.'
            )}
          </p>
        </div>
        {shown.weakKey && (
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {t(
              'admin.euAiAct.keys.weak',
              'This key is short or easy to guess. A random generated key is safer.'
            )}
          </p>
        )}
        {visible ? (
          <>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.euAiAct.keys.keyValue', 'Key')}
              </p>
              <pre
                ref={keyRef}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable secret must be keyboard reachable
                tabIndex={0}
                className={SECRET_BLOCK}
              >
                {shown.key}
              </pre>
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.euAiAct.keys.snippet', 'vLLM option')}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton
                    label={t('admin.euAiAct.keys.copySnippet', 'Copy option')}
                    getText={() => shown.vllmConfigSnippet}
                    targetRef={snippetRef}
                  />
                  <CopyButton
                    label={t('admin.euAiAct.keys.copyKey', 'Copy key')}
                    getText={() => shown.key}
                    targetRef={keyRef}
                  />
                </div>
              </div>
              <pre
                ref={snippetRef}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
                tabIndex={0}
                className={`${SECRET_BLOCK} whitespace-pre break-normal overflow-x-auto max-h-48 overflow-y-auto`}
              >
                {shown.vllmConfigSnippet}
              </pre>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {t(
                'admin.euAiAct.keys.autoHide',
                'The key is hidden again after {{seconds}} seconds.',
                { seconds: Math.round(autoHideMs / 1000) }
              )}
            </p>
          </>
        ) : (
          <div className="space-y-2" role="status">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.euAiAct.keys.hidden', 'The key is hidden.')}
            </p>
            <button type="button" onClick={onRevealAgain} className={BUTTON_SECONDARY}>
              <Icon name="eye" size="sm" />
              {t('admin.euAiAct.keys.revealAgain', 'Reveal again')}
            </button>
          </div>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
        <button type="button" onClick={onClose} className={BUTTON_PRIMARY}>
          {t('common.done', 'Done')}
        </button>
      </div>
    </Modal>
  );
}

const KEY_PATTERN = /^[0-9]{1,16}$/;

/**
 * "Add own key": a form dialog. The value is checked here for a plain integer
 * and again by the server (safe-integer range, duplicates).
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {(input: {key: string, label: string}) => Promise<void>} props.onSubmit - Throws on failure
 */
export function AddKeyDialog({ isOpen, onClose, onSubmit }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const close = useCallback(() => {
    setValue('');
    setLabel('');
    setReveal(false);
    setError(null);
    onClose();
  }, [onClose]);

  const submit = async event => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!KEY_PATTERN.test(trimmed)) {
      setError(
        t('admin.euAiAct.keys.addInvalid', 'Enter the key as a whole number (digits only).')
      );
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ key: trimmed, label: label.trim() });
      setValue('');
      setLabel('');
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      closeOnBackdropClick={false}
      initialFocusRef={inputRef}
      labelledBy="watermark-add-key-title"
    >
      <form onSubmit={submit} noValidate>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="watermark-add-key-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.euAiAct.keys.addTitle', 'Add an existing key')}
          </h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          {error && (
            <p
              role="alert"
              id="watermark-add-key-error"
              className="text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </p>
          )}
          <div>
            <label
              htmlFor="watermark-add-key-value"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.euAiAct.keys.addValue', 'Key (whole number)')}
            </label>
            <div className="mt-1 flex gap-2">
              <input
                ref={inputRef}
                id="watermark-add-key-value"
                type={reveal ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={e => setValue(e.target.value)}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={
                  error
                    ? 'watermark-add-key-help watermark-add-key-error'
                    : 'watermark-add-key-help'
                }
                className={`${INPUT} font-mono`}
              />
              <button
                type="button"
                onClick={() => setReveal(v => !v)}
                aria-pressed={reveal}
                className={BUTTON_SECONDARY}
              >
                <Icon name={reveal ? 'eye-slash' : 'eye'} size="sm" />
                {reveal
                  ? t('admin.euAiAct.keys.hideInput', 'Hide')
                  : t('admin.euAiAct.keys.showInput', 'Show')}
              </button>
            </div>
            <p
              id="watermark-add-key-help"
              className="mt-1 text-xs text-gray-600 dark:text-gray-400"
            >
              {t(
                'admin.euAiAct.keys.addHelp',
                'Must equal the key in the --watermark-config of your vLLM server. The new key becomes active; the current one is retired.'
              )}
            </p>
          </div>
          <div>
            <label
              htmlFor="watermark-add-key-label"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.euAiAct.keys.addLabel', 'Label (optional)')}
            </label>
            <input
              id="watermark-add-key-label"
              type="text"
              maxLength={100}
              value={label}
              onChange={e => setLabel(e.target.value)}
              className={`mt-1 ${INPUT}`}
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button type="button" onClick={close} className={BUTTON_SECONDARY}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {t('admin.euAiAct.keys.addConfirm', 'Add key')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
