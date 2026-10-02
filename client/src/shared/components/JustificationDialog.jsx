import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../hooks/useFocusTrap';
import Icon from './Icon';

/** Minimum justification length the server accepts (trimmed). */
export const DEFAULT_JUSTIFICATION_MIN_LENGTH = 10;

/**
 * Accessible dialog that asks for a written justification before an action
 * that the EU AI Act requires to be documented — switching off the AI
 * disclosure for an app, declaring an exemption, enabling a model that does
 * not watermark its text. The reason is stored with the admin's name and the
 * installation, so the dialog insists on a real sentence (min. length) and
 * says why.
 *
 * - traps focus while open and returns it on close; Escape and the backdrop cancel
 * - the textarea is labelled, described by the explanation and the length hint,
 *   and marked invalid with a visible error only after a submit attempt
 * - optional `choices` render a required radio group above the text (e.g. the
 *   exemption type); the chosen value is passed to `onConfirm`
 * - `onConfirm` may return a promise; while it runs the buttons are disabled,
 *   and a rejection is shown inside the dialog instead of closing it
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the dialog is shown
 * @param {string} props.title - Dialog heading
 * @param {React.ReactNode} props.description - Explanation shown above the form
 * @param {string} [props.label] - Label of the justification field
 * @param {string} [props.placeholder] - Placeholder of the justification field
 * @param {string} [props.confirmLabel] - Text of the confirm button
 * @param {boolean} [props.danger=false] - Styles the confirm button as destructive
 * @param {number} [props.minLength=10] - Minimum trimmed length of the justification
 * @param {Array<{value: string, label: string, description?: string}>} [props.choices] -
 *   Optional options the user must pick one of
 * @param {string} [props.choiceLabel] - Legend of the choices group
 * @param {(justification: string, choice: string|null) => (void|Promise<void>)} props.onConfirm
 * @param {() => void} props.onCancel
 * @returns {JSX.Element|null}
 * @example
 * <JustificationDialog
 *   isOpen={open}
 *   title="Switch off the AI disclosure?"
 *   description="Only for internal assistants used by trained staff."
 *   onConfirm={reason => api.optOut(reason)}
 *   onCancel={() => setOpen(false)}
 * />
 */
function JustificationDialog({ isOpen, ...props }) {
  // Mounted only while open, so every opening starts with an empty form.
  return isOpen ? <JustificationDialogPanel {...props} /> : null;
}

/**
 * The open dialog. See {@link JustificationDialog} for the props.
 *
 * @param {Object} props - JustificationDialog props without `isOpen`
 * @returns {JSX.Element}
 */
function JustificationDialogPanel({
  title,
  description,
  label,
  placeholder,
  confirmLabel,
  danger = false,
  minLength = DEFAULT_JUSTIFICATION_MIN_LENGTH,
  choices = null,
  choiceLabel,
  onConfirm,
  onCancel
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const textareaRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const [justification, setJustification] = useState('');
  const [choice, setChoice] = useState(null);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useFocusTrap(containerRef, {
    isActive: true,
    initialFocusRef: textareaRef,
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, submitting]);

  const trimmedLength = justification.trim().length;
  const tooShort = trimmedLength < minLength;
  const needsChoice = Array.isArray(choices) && choices.length > 0;
  const choiceMissing = needsChoice && !choice;
  const showTextError = attempted && tooShort;
  const showChoiceError = attempted && choiceMissing;

  const handleSubmit = async event => {
    event.preventDefault();
    setAttempted(true);
    if (tooShort || choiceMissing || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onConfirm(justification.trim(), needsChoice ? choice : null);
    } catch (error) {
      setSubmitError(
        error?.response?.data?.error ||
          error?.message ||
          t('aiTransparency.justification.failed', 'The change could not be saved.')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const confirmClasses = danger
    ? 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500'
    : 'bg-indigo-600 hover:bg-indigo-700 text-white focus:ring-indigo-500';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={submitting ? undefined : onCancel}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onSubmit={handleSubmit}
          noValidate
          className="relative w-full max-w-lg rounded-lg bg-white shadow-xl dark:bg-gray-800"
        >
          <div className="p-6">
            <div className="flex items-start gap-4">
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                  danger ? 'bg-red-100 dark:bg-red-900/40' : 'bg-amber-100 dark:bg-amber-900/40'
                }`}
                aria-hidden="true"
              >
                <Icon
                  name="exclamation-triangle"
                  className={`h-6 w-6 ${danger ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
                  {title}
                </h2>
                <div id={descriptionId} className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                  {description}
                </div>
              </div>
            </div>

            {needsChoice && (
              <fieldset className="mt-5" aria-describedby={showChoiceError ? errorId : undefined}>
                <legend className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {choiceLabel || t('aiTransparency.justification.choice', 'Type')}
                </legend>
                <div className="mt-2 space-y-2">
                  {choices.map(option => (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                    >
                      <input
                        type="radio"
                        name={`${fieldId}-choice`}
                        value={option.value}
                        checked={choice === option.value}
                        onChange={() => setChoice(option.value)}
                        className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>
                        <span className="block font-medium text-gray-900 dark:text-gray-100">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="block text-gray-600 dark:text-gray-400">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
                {showChoiceError && (
                  <p className="mt-1 text-sm text-red-700 dark:text-red-400">
                    {t('aiTransparency.justification.choiceRequired', 'Please choose one option.')}
                  </p>
                )}
              </fieldset>
            )}

            <div className="mt-5">
              <label
                htmlFor={fieldId}
                className="block text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {label || t('aiTransparency.justification.label', 'Justification')}
                <span className="text-red-600 dark:text-red-400" aria-hidden="true">
                  {' '}
                  *
                </span>
              </label>
              <textarea
                ref={textareaRef}
                id={fieldId}
                rows={4}
                required
                value={justification}
                onChange={event => setJustification(event.target.value)}
                placeholder={placeholder}
                aria-invalid={showTextError || undefined}
                aria-describedby={`${hintId}${showTextError ? ` ${errorId}` : ''}`}
                className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 dark:bg-gray-700 dark:text-gray-100 ${
                  showTextError ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'
                }`}
              />
              <p id={hintId} className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {t(
                  'aiTransparency.justification.hint',
                  'At least {{min}} characters ({{count}} so far). Stored with your name, the time and this installation, and written to the audit log.',
                  { min: minLength, count: trimmedLength }
                )}
              </p>
              {showTextError && (
                <p id={errorId} className="mt-1 text-sm text-red-700 dark:text-red-400">
                  {t(
                    'aiTransparency.justification.tooShort',
                    'Please give a justification of at least {{min}} characters.',
                    { min: minLength }
                  )}
                </p>
              )}
            </div>

            {submitError && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
              >
                {submitError}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 rounded-b-lg border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/30">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`rounded-lg px-4 py-2 font-medium transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${confirmClasses}`}
            >
              {submitting
                ? t('aiTransparency.justification.saving', 'Saving…')
                : confirmLabel || t('common.confirm', 'Confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default JustificationDialog;
