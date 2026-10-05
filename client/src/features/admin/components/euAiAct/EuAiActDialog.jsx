import { useEffect, useId, useRef } from 'react';
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import useFocusTrap from '../../../../shared/hooks/useFocusTrap';
import { Button } from './EuAiActUi';

/**
 * Accessible modal dialog with a form body, used by the EU AI Act tabs for
 * every input flow (approve expert, create key group, install certificate,
 * export bundle, …) and for reveal/confirm steps that need more than a
 * sentence of text.
 *
 * Behaviour (WCAG 2.1 AA):
 * - `role="dialog"`, `aria-modal`, named by its title and described by its
 *   description;
 * - focus moves into the dialog (to `initialFocusRef` or the first field),
 *   is trapped while open and returns to the trigger on close;
 * - Escape and the close button cancel, unless a submit is in flight;
 * - the body is a `<form>`, so Enter in a text field submits.
 *
 * The dialog holds no user-facing text of its own; all labels are props.
 *
 * @param {Object} props
 * @param {boolean} props.open - Whether the dialog is shown
 * @param {string} props.title - Heading and accessible name
 * @param {React.ReactNode} [props.description] - Intro text, linked via aria-describedby
 * @param {() => void} props.onClose - Called on cancel, Escape, backdrop or close button
 * @param {() => void} [props.onSubmit] - Called on submit; omit for read-only dialogs
 * @param {string} [props.submitLabel] - Primary button text (required with onSubmit)
 * @param {string} props.cancelLabel - Secondary button text ("Cancel" / "Close")
 * @param {string} props.closeLabel - Accessible name of the X button
 * @param {boolean} [props.submitting=false] - Shows a spinner and blocks closing
 * @param {boolean} [props.submitDisabled=false]
 * @param {boolean} [props.danger=false] - Red primary button + warning icon
 * @param {'md'|'lg'|'xl'} [props.size='md']
 * @param {React.RefObject<HTMLElement>} [props.initialFocusRef]
 * @param {boolean} [props.focusCancel=false] - Start on the cancel button (safer for
 *   destructive confirmations); ignored when `initialFocusRef` is given
 * @param {React.ReactNode} [props.children] - Form fields / content
 *
 * @example
 * <EuAiActDialog open={open} title={t('…')} onClose={close} onSubmit={save}
 *   submitLabel={t('…')} cancelLabel={t('…')} closeLabel={t('…')}>
 *   <TextField id="x" label="…" value={v} onChange={setV} />
 * </EuAiActDialog>
 */
function EuAiActDialog({
  open,
  title,
  description,
  onClose,
  onSubmit,
  submitLabel,
  cancelLabel,
  closeLabel,
  submitting = false,
  submitDisabled = false,
  danger = false,
  size = 'md',
  initialFocusRef,
  focusCancel = false,
  children
}) {
  const containerRef = useRef(null);
  const cancelRef = useRef(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  useFocusTrap(containerRef, {
    isActive: open,
    initialFocusRef: initialFocusRef || (focusCancel ? cancelRef : undefined),
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const widths = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  const handleSubmit = event => {
    event.preventDefault();
    if (!onSubmit || submitting || submitDisabled) return;
    onSubmit();
  };

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
          aria-describedby={description ? descriptionId : undefined}
          className={`relative w-full ${widths[size] || widths.md} bg-white dark:bg-gray-800 rounded-lg shadow-xl flex flex-col max-h-[90vh]`}
        >
          <form onSubmit={handleSubmit} noValidate className="flex flex-col min-h-0">
            <div className="flex items-start gap-3 px-6 pt-5 pb-3">
              {danger && (
                <div
                  className="shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center"
                  aria-hidden="true"
                >
                  <ExclamationTriangleIcon className="w-6 h-6 text-red-600 dark:text-red-400" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
                  {title}
                </h2>
                {description && (
                  <div
                    id={descriptionId}
                    className="mt-1 text-sm text-gray-600 dark:text-gray-300 space-y-2"
                  >
                    {description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                aria-label={closeLabel}
                className="shrink-0 rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                <XMarkIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {children && (
              <div className="px-6 py-3 space-y-4 overflow-y-auto min-h-0">{children}</div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-4 mt-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-lg">
              <Button ref={cancelRef} onClick={onClose} disabled={submitting}>
                {cancelLabel}
              </Button>
              {onSubmit && (
                <Button
                  type="submit"
                  variant={danger ? 'danger' : 'primary'}
                  busy={submitting}
                  disabled={submitDisabled}
                >
                  {submitLabel}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default EuAiActDialog;
