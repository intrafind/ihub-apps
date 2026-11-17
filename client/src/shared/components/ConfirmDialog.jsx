// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../hooks/useFocusTrap';
import useOverlayStack from '../hooks/useOverlayStack';
// Heroicons directly (as Drawer does), not ./Icon: Icon pulls in the runtime
// base path, which every Modal and form would then depend on through this dialog.
import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const SECONDARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-gray-800 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

const CONFIRM_BUTTON_BASE_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-4 py-2 text-sm font-medium rounded-md text-white transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-800 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

const DANGER_CALLOUT_CLASS =
  'rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200';

const TOKEN_INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm font-mono focus:outline-hidden focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500';

/**
 * Accessible confirmation dialog. Replaces `window.confirm()` with a styled
 * `alertdialog` that:
 *   - traps focus while open and returns it to the trigger on close;
 *   - initially focuses Cancel (the safe default), or the type-to-confirm
 *     field when there is one;
 *   - closes on backdrop click and Escape — Escape only when it is the
 *     topmost overlay (shared overlay stack), so a confirmation opened over a
 *     modal never closes the modal too;
 *   - renders into `document.body`, so a sticky or scrolling ancestor can
 *     neither clip it nor paint over it;
 *   - gets unique element ids per instance (`useId`), so two open dialogs
 *     never share an accessible name.
 *
 * Confirmation tiers (see `docs/admin-ui.md`):
 *   1. named confirm: `title` names the type and the item, `confirmLabel` is a verb;
 *   2. dependency-aware: `consequences` lists what else is affected;
 *   3. type-to-confirm: `typedConfirmation` for actions that replace
 *      whole-system state or remove something with no restore path.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the dialog is shown.
 * @param {string} props.title - Names the action and the item: `Delete model "GPT-4o"?`.
 * @param {React.ReactNode} [props.message] - Scope and consequence of the action.
 * @param {React.ReactNode[]} [props.consequences] - Bulleted list of what will happen
 *   or what is affected.
 * @param {boolean} [props.irreversible=false] - Shows the "This can't be undone." callout.
 * @param {{ token: string, label?: React.ReactNode }} [props.typedConfirmation] - When set,
 *   the confirm button stays disabled until the user types `token` exactly
 *   (surrounding whitespace ignored, case-sensitive). The token is shown in a
 *   code chip with a copy button; pasting is allowed. Tokens are ids or host
 *   names, never translated words.
 * @param {boolean} [props.busy=false] - The action is running: spinner on the
 *   confirm button, both buttons inert, Escape and backdrop ignored.
 * @param {string|null} [props.error] - Inline error shown inside the dialog
 *   (`role="alert"`); the dialog stays open so the user can retry or cancel.
 * @param {{ reason: React.ReactNode }} [props.blocked] - The action is not possible:
 *   shows the reason and a single Close button that calls `onDeny`.
 * @param {string} [props.confirmLabel] - Verb (plus object) on the confirm button,
 *   e.g. "Delete model". Required at new call sites; never "OK".
 * @param {string} [props.denyLabel] - Label of the cancel button (default "Cancel").
 * @param {string} [props.busyLabel] - Text announced while busy (default "Working…").
 * @param {boolean} [props.danger=false] - Styles the dialog as destructive (red).
 * @param {string} [props.zIndexClassName='z-50'] - Stacking of the dialog. A dialog
 *   opened from an overlay raised above z-50 passes that overlay's class; being
 *   portalled later, it then paints above it.
 * @param {() => void} props.onConfirm - Called when the user confirms.
 * @param {() => void} props.onDeny - Called on Cancel, Close, Escape and backdrop click.
 * @returns {React.ReactPortal|null}
 *
 * @example
 * <ConfirmDialog
 *   isOpen={Boolean(pending)}
 *   title={t('admin.confirm.deleteTitle', { type: t('admin.confirm.types.model'), name })}
 *   message={t('admin.confirm.irreversible')}
 *   confirmLabel={t('admin.confirm.delete')}
 *   danger
 *   busy={deleting}
 *   error={deleteError}
 *   onConfirm={handleDelete}
 *   onDeny={() => setPending(null)}
 * />
 */
function ConfirmDialog({ isOpen, ...props }) {
  // Mounted only while open, so a reopened dialog starts empty: a token typed
  // for one item never carries over to the next.
  if (!isOpen) return null;
  return <ConfirmDialogPanel {...props} />;
}

/**
 * The open dialog. See {@link ConfirmDialog} for the props.
 *
 * @param {Object} props
 * @returns {React.ReactPortal}
 */
function ConfirmDialogPanel({
  title,
  message,
  consequences,
  irreversible = false,
  typedConfirmation,
  busy = false,
  error = null,
  blocked,
  confirmLabel,
  denyLabel,
  busyLabel,
  danger = false,
  zIndexClassName = 'z-50',
  onConfirm,
  onDeny
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const denyButtonRef = useRef(null);
  const tokenInputRef = useRef(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const messageId = `${baseId}-message`;
  const tokenHintId = `${baseId}-token-hint`;
  const tokenInputId = `${baseId}-token-input`;
  const [typedValue, setTypedValue] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);

  const requiredToken = !blocked && typedConfirmation?.token ? typedConfirmation.token : null;
  const tokenMatches = requiredToken === null || typedValue.trim() === requiredToken;
  const confirmDisabled = busy || !tokenMatches;

  useFocusTrap(containerRef, {
    isActive: true,
    initialFocusRef: requiredToken ? tokenInputRef : denyButtonRef,
    returnFocusOnDeactivate: true
  });

  // A menu that opened this dialog returns focus to its own trigger as it
  // closes, which can land after the trap's initial focus: put focus back into
  // the dialog on the next frame if it ended up outside.
  // The frame is cancelled once the user confirms: from then on the action
  // owns focus (it may move it to the page, e.g. a heading after a delete),
  // and a late frame would pull focus into a dialog about to unmount and
  // drop it on <body>.
  const refocusFrameRef = useRef(null);
  useEffect(() => {
    refocusFrameRef.current = requestAnimationFrame(() => {
      refocusFrameRef.current = null;
      const container = containerRef.current;
      const target = (requiredToken ? tokenInputRef : denyButtonRef).current;
      if (container && target && !container.contains(document.activeElement)) target.focus();
    });
    return () => {
      if (refocusFrameRef.current !== null) cancelAnimationFrame(refocusFrameRef.current);
      refocusFrameRef.current = null;
    };
    // Only on open: later focus moves are the user's.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  // Escape is routed by the overlay stack; ignored while the action runs.
  useOverlayStack(true, busy ? null : onDeny);

  const handleDeny = () => {
    if (busy) return;
    onDeny();
  };

  const handleConfirm = () => {
    if (confirmDisabled) return;
    if (refocusFrameRef.current !== null) {
      cancelAnimationFrame(refocusFrameRef.current);
      refocusFrameRef.current = null;
    }
    onConfirm();
  };

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(requiredToken);
      setTokenCopied(true);
    } catch {
      // Copy is a convenience; typing the token still works.
    }
  };

  const confirmToneClass = danger
    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
    : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500';

  const hasConsequences = Array.isArray(consequences) && consequences.length > 0;

  return createPortal(
    <div className={`fixed inset-0 ${zIndexClassName} overflow-y-auto`} role="presentation">
      <div
        className="fixed inset-0 bg-black/50 dark:bg-black/70 transition-opacity"
        onClick={handleDeny}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={containerRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={messageId}
          aria-busy={busy ? 'true' : undefined}
          className="relative bg-white dark:bg-gray-800 rounded-md shadow-xl max-w-md w-full"
        >
          <div className="p-6">
            <div className="flex items-start gap-4">
              {(danger || blocked) && (
                <div
                  className="shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center"
                  aria-hidden="true"
                >
                  <ExclamationTriangleIcon className="w-6 h-6 text-red-700 dark:text-red-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h2
                  id={titleId}
                  className="text-lg font-semibold text-gray-900 dark:text-white break-words"
                >
                  {title}
                </h2>
                <div id={messageId} className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                  {blocked ? blocked.reason : message}
                  {!blocked && hasConsequences && (
                    <ul className="mt-3 list-disc space-y-1 pl-5">
                      {consequences.map((item, index) => (
                        // Consequences are static for the dialog's lifetime.
                        // eslint-disable-next-line @eslint-react/no-array-index-key
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {!blocked && irreversible && (
                    <p className={`mt-4 ${DANGER_CALLOUT_CLASS}`}>
                      {t('common.confirmDialog.irreversible', "This can't be undone.")}
                    </p>
                  )}
                </div>

                {requiredToken && (
                  <div className="mt-4">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
                      <span id={tokenHintId} className="inline-flex flex-wrap items-center gap-1.5">
                        <label htmlFor={tokenInputId}>
                          {typedConfirmation.label ||
                            t('common.confirmDialog.typeToConfirm', 'To confirm, type')}
                        </label>
                        <code className="rounded-sm bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 font-mono text-gray-900 dark:text-gray-100 break-all">
                          {requiredToken}
                        </code>
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyToken}
                        className="rounded-sm px-1 text-xs font-medium text-indigo-700 dark:text-indigo-300 underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                      >
                        {tokenCopied
                          ? t('common.copied', 'Copied!')
                          : t('common.confirmDialog.copyToken', 'Copy')}
                      </button>
                    </div>
                    <input
                      ref={tokenInputRef}
                      id={tokenInputId}
                      aria-labelledby={tokenHintId}
                      type="text"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={typedValue}
                      readOnly={busy}
                      onChange={event => setTypedValue(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleConfirm();
                        }
                      }}
                      className={`mt-1 ${TOKEN_INPUT_CLASS}`}
                    />
                  </div>
                )}

                {error && !blocked && (
                  <div role="alert" className={`mt-4 ${DANGER_CALLOUT_CLASS}`}>
                    {error}
                  </div>
                )}
                {busy && (
                  <p role="status" className="sr-only">
                    {busyLabel || t('common.confirmDialog.busy', 'Working…')}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-md min-[400px]:flex-row min-[400px]:items-center min-[400px]:justify-end">
            <button
              ref={denyButtonRef}
              type="button"
              onClick={handleDeny}
              aria-disabled={busy ? 'true' : undefined}
              className={SECONDARY_BUTTON_CLASS}
            >
              {blocked ? t('common.close', 'Close') : denyLabel || t('common.cancel', 'Cancel')}
            </button>
            {!blocked && (
              <button
                type="button"
                onClick={handleConfirm}
                aria-disabled={confirmDisabled ? 'true' : undefined}
                aria-describedby={requiredToken && !tokenMatches ? tokenHintId : undefined}
                className={`${CONFIRM_BUTTON_BASE_CLASS} ${confirmToneClass}`}
              >
                {busy && <ArrowPathIcon className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {confirmLabel || t('common.confirm', 'Confirm')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ConfirmDialog;
