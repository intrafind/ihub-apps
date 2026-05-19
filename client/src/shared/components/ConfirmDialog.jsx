import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../hooks/useFocusTrap';
import Icon from './Icon';

/**
 * Accessible confirmation dialog. Replaces ad-hoc `window.confirm()` calls
 * with a styled modal that:
 *   - traps focus while open
 *   - closes on backdrop click and Escape
 *   - initially focuses the deny button (safer default for destructive flows)
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {string} props.title
 * @param {React.ReactNode} props.message
 * @param {string} [props.confirmLabel]
 * @param {string} [props.denyLabel]
 * @param {boolean} [props.danger=false] - styles the confirm button as destructive (red).
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onDeny
 */
function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel,
  denyLabel,
  danger = false,
  onConfirm,
  onDeny
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const denyButtonRef = useRef(null);

  useFocusTrap(containerRef, {
    isActive: isOpen,
    initialFocusRef: denyButtonRef,
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDeny();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onDeny]);

  if (!isOpen) return null;

  const confirmClasses = danger
    ? 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500'
    : 'bg-indigo-600 hover:bg-indigo-700 text-white focus:ring-indigo-500';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onDeny}
        aria-hidden="true"
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={containerRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
          className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
        >
          <div className="p-6">
            <div className="flex items-start gap-4">
              {danger && (
                <div
                  className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center"
                  aria-hidden="true"
                >
                  <Icon
                    name="exclamation-triangle"
                    className="w-6 h-6 text-red-600 dark:text-red-400"
                  />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h2
                  id="confirm-dialog-title"
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                  {title}
                </h2>
                <div
                  id="confirm-dialog-message"
                  className="mt-2 text-sm text-gray-600 dark:text-gray-300"
                >
                  {message}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-lg">
            <button
              ref={denyButtonRef}
              type="button"
              onClick={onDeny}
              className="px-4 py-2 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {denyLabel || t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`px-4 py-2 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${confirmClasses}`}
            >
              {confirmLabel || t('common.confirm', 'Confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
