// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import Modal from '../../../../shared/components/Modal';
import { disableConformity, enableConformity } from '../../../../api/euAiActAdminApi';
import { formatWho } from './ConformityHistory';

export const MIN_REASON = 20;
export const MAX_REASON = 1000;
const OFF_ITEMS = ['rule', 'notice', 'ack', 'records', 'watermark', 'media', 'verify', 'check'];
const KEEP_ITEMS = ['ack', 'records', 'keys', 'settings', 'history'];
const DRAFT_KEY = 'ihub-eu-ai-act-switch-reason';

function readDraft() {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) || '';
  } catch {
    return '';
  }
}
function writeDraft(value) {
  try {
    if (value) window.sessionStorage.setItem(DRAFT_KEY, value);
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: the draft is just not kept */
  }
}

const FIELD =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500 focus:outline-hidden';

/**
 * The dialog of the EU AI Act master switch. `mode="off"` demands the reason
 * (20-1000 characters after trimming) and the acceptance; `mode="on"` takes an
 * optional note. The server checks the same rules and records who, when and why.
 * A conflict (another admin was first) keeps the dialog open with the typed text.
 *
 * @param {Object} props
 * @param {'off'|'on'} props.mode
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {(record: Object, mode: 'off'|'on') => void} props.onDone - Called with the new record
 * @param {() => void} props.onReload - Reload the status (after a conflict)
 */
export default function ConformityDialog({ mode, isOpen, onClose, onDone, onReload }) {
  const { t } = useTranslation();
  const off = mode === 'off';
  const titleId = useId();
  const introId = useId();
  const hintId = useId();
  const counterId = useId();
  const reasonRef = useRef(null);
  const [reason, setReasonState] = useState(() => (off ? readDraft() : ''));
  const [accepted, setAccepted] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState(null); // { kind: 'conflict'|'forbidden'|'error', record? }

  const setReason = value => {
    setReasonState(value);
    if (off) writeDraft(value);
  };
  const trimmed = reason.trim();
  const length = trimmed.length;
  const tooShort = off && length < MIN_REASON;
  const tooLong = length > MAX_REASON;
  const missing = tooShort ? MIN_REASON - length : 0;
  const valid = !tooLong && (!off || (!tooShort && accepted));
  const hint = off
    ? tooShort
      ? t('admin.euAiAct.master.needMore', 'Enter at least {{n}} more characters.', { n: missing })
      : !accepted
        ? t('admin.euAiAct.master.needAck', 'Tick the box to continue.')
        : ''
    : '';

  const close = () => {
    if (saving) return;
    onClose();
  };

  const submit = async event => {
    event?.preventDefault();
    setAttempted(true);
    if (!valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const record = off
        ? await disableConformity({ reason: trimmed })
        : await enableConformity({ reason: trimmed || undefined });
      if (off) writeDraft('');
      onDone(record, mode);
    } catch (error) {
      const status = error?.response?.status;
      const code = error?.response?.data?.code;
      if (status === 409 || code === 'CONFLICT') {
        setFailure({ kind: 'conflict', details: error.response?.data?.details });
      } else if (code === 'INTERACTIVE_SESSION_REQUIRED') {
        setFailure({ kind: 'forbidden' });
      } else {
        setFailure({ kind: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  const copyReason = async () => {
    try {
      await navigator.clipboard.writeText(reason);
    } catch {
      /* clipboard unavailable */
    }
  };

  const conflictState = failure?.details?.enabled
    ? t('admin.euAiAct.master.on', 'On')
    : t('admin.euAiAct.master.off', 'Switched off');

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      closeOnBackdropClick={false}
      initialFocusRef={reasonRef}
      labelledBy={titleId}
      maxWidthClassName="max-w-2xl"
      maxHeightClassName="max-h-[90dvh]"
      overlayPaddingClassName="p-0 sm:p-4"
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex min-h-0 flex-col"
        aria-describedby={introId}
      >
        <div className="overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {off
                ? t('admin.euAiAct.master.dlgOffTitle', 'Switch off EU AI Act features')
                : t('admin.euAiAct.master.dlgOnTitle', 'Switch EU AI Act features on again')}
            </h2>
            <p id={introId} className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {off
                ? t(
                    'admin.euAiAct.master.dlgOffIntro',
                    'Please read what changes before you continue.'
                  )
                : t(
                    'admin.euAiAct.master.dlgOnIntro',
                    'Everything listed as switched off becomes active again immediately, with your saved settings. If enforcement is on, users who have not confirmed the current statement are asked at their next message.'
                  )}
            </p>
          </div>

          {off && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 text-sm">
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.euAiAct.master.offListTitle', 'This will be switched off')}
                  </h3>
                  <ul className="mt-1 list-disc pl-5 space-y-0.5 text-gray-700 dark:text-gray-300">
                    {OFF_ITEMS.map(key => (
                      <li key={key}>{t(`admin.euAiAct.master.offList.${key}`, key)}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.euAiAct.master.keepTitle', 'This stays')}
                  </h3>
                  <ul className="mt-1 list-disc pl-5 space-y-0.5 text-gray-700 dark:text-gray-300">
                    {KEEP_ITEMS.map(key => (
                      <li key={key}>{t(`admin.euAiAct.master.keepList.${key}`, key)}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {/* [LEGAL] draft wording: needs legal review, not legal advice. */}
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-100 flex gap-3">
                <Icon name="information-circle" size="md" className="shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p>
                    {t(
                      'admin.euAiAct.master.legal',
                      "Switching off does not remove your organisation's obligations under the EU AI Act. The duty stays with you as the deployer. This is not legal advice."
                    )}
                  </p>
                  <p>
                    {t(
                      'admin.euAiAct.master.vllm',
                      'A vLLM server started with a watermark configuration that enforces marking keeps marking regardless of iHub. Restart vLLM without that option to stop marking at the source.'
                    )}
                  </p>
                </div>
              </div>
            </>
          )}

          <div>
            <label
              htmlFor={`${titleId}-reason`}
              className="block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {off
                ? t('admin.euAiAct.master.reasonField', 'Why are you switching this off?')
                : t('admin.euAiAct.master.reasonOptional', 'Reason (optional)')}
              {off && <span aria-hidden="true"> *</span>}
            </label>
            <textarea
              id={`${titleId}-reason`}
              ref={reasonRef}
              data-testid="conformity-reason"
              rows={4}
              value={reason}
              readOnly={saving}
              required={off}
              aria-describedby={`${hintId} ${counterId}`}
              aria-invalid={attempted && !valid ? 'true' : undefined}
              onChange={event => setReason(event.target.value)}
              className={`${FIELD} mt-1 min-h-24 resize-y`}
            />
            <div className="mt-1 flex flex-wrap justify-between gap-x-4 text-xs text-gray-600 dark:text-gray-400">
              <p id={hintId}>
                {t(
                  'admin.euAiAct.master.reasonHint',
                  'Visible to all admins and kept in the audit trail. Do not enter personal data or secrets.'
                )}
              </p>
              <p id={counterId} className="tabular-nums">
                {tooLong
                  ? t('admin.euAiAct.master.overLimit', 'Over the limit of 1000 characters.')
                  : off
                    ? t(
                        'admin.euAiAct.master.counter',
                        '{{count}} of 1000 characters, at least 20',
                        { count: length }
                      )
                    : t('admin.euAiAct.master.counterOptional', '{{count}} of 1000 characters', {
                        count: length
                      })}
              </p>
            </div>
          </div>

          {off && (
            <label className="flex items-start gap-3 text-sm text-gray-900 dark:text-gray-100">
              <input
                type="checkbox"
                data-testid="conformity-accept"
                checked={accepted}
                disabled={saving}
                onChange={event => setAccepted(event.target.checked)}
                className="mt-0.5 h-5 w-5 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              {/* [LEGAL] draft wording */}
              <span>
                {t(
                  'admin.euAiAct.master.ack',
                  'I understand that the legal duty stays with my organisation.'
                )}
              </span>
            </label>
          )}

          {failure && (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-900/20 dark:text-red-100"
            >
              {failure.kind === 'conflict' ? (
                <>
                  <p>
                    {t(
                      'admin.euAiAct.master.conflict',
                      'Another admin changed this at {{time}} ({{name}}). It is now {{state}}.',
                      {
                        time: failure.details?.changedAt
                          ? new Date(failure.details.changedAt).toLocaleTimeString()
                          : '',
                        name: formatWho(failure.details?.changedBy),
                        state: conflictState
                      }
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onReload();
                        onClose();
                      }}
                      className="px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      {t('admin.euAiAct.master.reload', 'Reload status')}
                    </button>
                    <button
                      type="button"
                      onClick={copyReason}
                      className="px-3 py-1.5 rounded-md border border-red-300 dark:border-red-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      {t('admin.euAiAct.master.copyReason', 'Copy my reason')}
                    </button>
                  </div>
                </>
              ) : failure.kind === 'forbidden' ? (
                t(
                  'admin.euAiAct.master.forbidden',
                  'Only an interactive admin session can switch the features.'
                )
              ) : (
                t(
                  'admin.euAiAct.master.saveError',
                  'Could not save. Your reason is kept. Please try again.'
                )
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
          {hint && (
            <p id={`${titleId}-need`} className="mb-3 text-sm text-gray-700 dark:text-gray-300">
              {hint}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('admin.euAiAct.master.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              data-testid="conformity-confirm"
              aria-disabled={!valid || saving ? 'true' : undefined}
              aria-describedby={hint ? `${titleId}-need` : undefined}
              className={`px-4 py-2 text-sm font-medium rounded-md text-white focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
                off
                  ? 'bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              } ${!valid || saving ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              {saving
                ? t('admin.euAiAct.master.saving', 'Saving...')
                : off
                  ? t('admin.euAiAct.master.confirmOff', 'Switch off')
                  : t('admin.euAiAct.master.confirmOn', 'Switch on')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
