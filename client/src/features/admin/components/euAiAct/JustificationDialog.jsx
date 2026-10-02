import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../../../../shared/hooks/useFocusTrap';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  JUSTIFICATION_MAX_LENGTH,
  JUSTIFICATION_MIN_LENGTH,
  isJustificationValid
} from '../../utils/euAiAct';

/**
 * Accessible modal that asks for a written justification before an EU AI Act
 * record is made (dismissing a warning, switching off the disclosure,
 * declaring an exemption, acknowledging an unmarked model, …).
 *
 * Behaviour:
 * - Focus moves into the dialog when it opens (the first extra field if
 *   `children` are given, else the justification field), stays trapped
 *   inside while open, and returns to the trigger on close.
 * - Escape and the backdrop close it, except while a submit is in flight.
 * - The submit button stays disabled until the trimmed justification has at
 *   least `minLength` characters (and `canSubmit` is true).
 * - `onSubmit(reason)` receives the trimmed text. When its promise resolves
 *   the dialog calls `onClose()`; when it rejects, the server message is shown
 *   inside the dialog and the dialog stays open so nothing typed is lost.
 *
 * @param {Object} props
 * @param {boolean} props.open - Whether the dialog is shown.
 * @param {string} props.title - Dialog heading (also its accessible name).
 * @param {React.ReactNode} [props.description] - What the record means; read
 *   out as the dialog description.
 * @param {string} [props.label] - Label of the justification field.
 * @param {number} [props.minLength=10] - Minimum trimmed length.
 * @param {string} [props.submitLabel] - Text of the submit button.
 * @param {(reason: string) => Promise<unknown>} props.onSubmit
 * @param {() => void} props.onClose
 * @param {React.ReactNode} [props.children] - Extra fields rendered above the
 *   justification (e.g. the exemption type). Their state belongs to the parent.
 * @param {boolean} [props.canSubmit=true] - Extra validity from `children`;
 *   the submit button is disabled while false.
 * @param {string} [props.placeholder] - Placeholder of the justification field.
 *
 * @example
 * <JustificationDialog
 *   open={Boolean(target)}
 *   title={t('admin.euAiAct.models.ackDialog.title', 'Acknowledge unmarked output')}
 *   description={t('admin.euAiAct.models.ackDialog.description', '…')}
 *   label={t('admin.euAiAct.dialog.justification', 'Justification')}
 *   submitLabel={t('admin.euAiAct.models.ackDialog.submit', 'Record acknowledgement')}
 *   onSubmit={reason => acknowledgeUnmarkedModel(target.id, reason).then(reload)}
 *   onClose={() => setTarget(null)}
 * />
 */
function JustificationDialog({ open, ...props }) {
  // The body mounts on every opening, so each one starts with an empty form.
  if (!open) return null;
  return <JustificationDialogBody {...props} />;
}

/**
 * The open dialog. Mounted by {@link JustificationDialog} only while open.
 * Takes the same props minus `open`.
 */
function JustificationDialogBody({
  title,
  description,
  label,
  minLength = JUSTIFICATION_MIN_LENGTH,
  submitLabel,
  onSubmit,
  onClose,
  children,
  canSubmit = true,
  placeholder
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const fieldId = `${baseId}-reason`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const containerRef = useRef(null);
  const textareaRef = useRef(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // With extra fields (children) focus starts on the first of them, so the
  // form is filled top to bottom; otherwise on the justification field.
  useFocusTrap(containerRef, {
    isActive: true,
    initialFocusRef: children ? undefined : textareaRef,
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitting, onClose]);

  const trimmedLength = reason.trim().length;
  const reasonValid = isJustificationValid(reason, minLength);
  const submitDisabled = !reasonValid || !canSubmit || submitting;

  const handleSubmit = async event => {
    event.preventDefault();
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setSubmitting(false);
      onClose();
    } catch (err) {
      setSubmitting(false);
      setError(getAdminApiErrorMessage(err));
      // Keep keyboard users inside the dialog, on the field they may fix.
      textareaRef.current?.focus();
    }
  };

  const describedBy = [description ? descriptionId : null].filter(Boolean).join(' ') || undefined;
  const fieldDescribedBy = [hintId, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        aria-hidden="true"
        onClick={submitting ? undefined : onClose}
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full"
        >
          <form onSubmit={handleSubmit} noValidate>
            <div className="p-6 space-y-4">
              <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
                {title}
              </h2>
              {description && (
                <div
                  id={descriptionId}
                  className="text-sm text-gray-600 dark:text-gray-300 space-y-2"
                >
                  {description}
                </div>
              )}

              {children}

              <div>
                <label
                  htmlFor={fieldId}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
                >
                  {label || t('admin.euAiAct.dialog.justification', 'Justification')}
                  <span className="text-red-600 dark:text-red-400" aria-hidden="true">
                    {' '}
                    *
                  </span>
                </label>
                <textarea
                  ref={textareaRef}
                  id={fieldId}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={4}
                  maxLength={JUSTIFICATION_MAX_LENGTH}
                  required
                  aria-required="true"
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={fieldDescribedBy}
                  placeholder={placeholder}
                  readOnly={submitting}
                  className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm read-only:opacity-60"
                />
                <div id={hintId} className="mt-1 space-y-0.5 text-xs">
                  <p
                    className={
                      reasonValid
                        ? 'text-gray-500 dark:text-gray-400'
                        : 'text-amber-800 dark:text-amber-300'
                    }
                  >
                    {reasonValid
                      ? t('admin.euAiAct.dialog.lengthOk', '{{count}} characters.', {
                          count: trimmedLength
                        })
                      : t(
                          'admin.euAiAct.dialog.lengthHint',
                          'At least {{min}} characters ({{count}} so far).',
                          { min: minLength, count: trimmedLength }
                        )}
                  </p>
                  <p className="text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.euAiAct.dialog.recordNote',
                      'Stored with your user ID, the time, this installation and the iHub version, and written to the audit log.'
                    )}
                  </p>
                </div>
              </div>

              {error && (
                <div
                  id={errorId}
                  role="alert"
                  className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-700 dark:text-red-300"
                >
                  {error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-lg">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={submitDisabled}
                aria-disabled={submitDisabled}
                className="px-4 py-2 text-sm rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-gray-300 disabled:text-gray-600 dark:disabled:bg-gray-600 dark:disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                {submitting
                  ? t('admin.euAiAct.dialog.saving', 'Saving…')
                  : submitLabel || t('admin.euAiAct.dialog.submit', 'Save')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default JustificationDialog;
