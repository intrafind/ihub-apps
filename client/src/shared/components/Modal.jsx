// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../hooks/useFocusTrap';
import useOverlayStack, { OverlayOwner } from '../hooks/useOverlayStack';
import ConfirmDialog from './ConfirmDialog';

/**
 * Shared overlay dialog primitive: backdrop, focus trap, Escape-to-close and
 * `aria-modal`. Renders nothing while closed so callers can keep an
 * `if (!data) return null;` guard above it for their own data dependencies.
 *
 * Escape closes only the topmost overlay (shared overlay stack): a
 * confirmation opened over this modal takes the Escape for itself.
 *
 * Form modals pass `isDirty` while the user has entered something. Then
 * Escape (and `requestClose`, which the modal's ✕ / Cancel button should
 * call) first asks "Discard changes?", and a backdrop click does nothing — a
 * stray click is not an intent to throw work away. Without `isDirty` the
 * behaviour is unchanged.
 *
 * `onClose` is called with no arguments, as before. Callers that want their
 * ✕ button to honour the dirty guard render the children as a function:
 * `{({ requestClose }) => <button onClick={requestClose}>✕</button>}`.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether the modal is shown.
 * @param {() => void} props.onClose - Closes the modal (after the discard question when dirty).
 * @param {React.ReactNode | ((api: { requestClose: () => void }) => React.ReactNode)} props.children
 * @param {boolean} [props.isDirty=false] - The modal holds unsaved input.
 * @param {string} [props.dirtyTitle] - Name of the modal used in the discard question
 *   ("What you entered in "{title}" will be lost.").
 * @param {boolean} [props.closeOnBackdropClick=true] - Backdrop click closes a clean modal.
 */
function Modal({ isOpen, ...props }) {
  // Mounted only while open, so a reopened modal never carries a pending
  // discard question from before.
  if (!isOpen) return null;
  return <ModalPanel {...props} />;
}

/**
 * The open modal. See {@link Modal} for the props.
 *
 * @param {Object} props
 * @returns {JSX.Element}
 */
function ModalPanel({
  onClose,
  children,
  isDirty = false,
  dirtyTitle,
  maxWidthClassName = 'max-w-lg',
  closeOnBackdropClick = true,
  initialFocusRef,
  panelClassName = '',
  // Stacking of the overlay; raised where the dialog opens above a full-window viewer.
  zIndexClassName = 'z-50',
  // Id of the element that names the dialog (its heading).
  labelledBy,
  // Padding around the panel and its height cap; narrow hosts (the Outlook
  // task pane) tighten both so the panel gets the room.
  overlayPaddingClassName = 'p-4',
  maxHeightClassName = 'max-h-[90vh]',
  surfaceClassName = 'bg-white dark:bg-gray-800'
}) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const [discardAsked, setDiscardAsked] = useState(false);
  // A modal that became clean has nothing to discard: drop a pending question,
  // so it does not reappear when the modal turns dirty again.
  if (!isDirty && discardAsked) setDiscardAsked(false);

  useFocusTrap(containerRef, {
    isActive: true,
    initialFocusRef,
    returnFocusOnDeactivate: true
  });

  /** Closes the modal, or asks first when it holds unsaved input. */
  const requestClose = useCallback(() => {
    if (isDirty) {
      setDiscardAsked(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  // Overlays rendered in the modal (its children, the discard question) stack above it.
  const { owner: overlayOwner } = useOverlayStack(true, requestClose);

  const handleBackdropClick = closeOnBackdropClick && !isDirty ? onClose : undefined;

  return (
    <OverlayOwner owner={overlayOwner}>
      <div
        className={`fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full ${zIndexClassName} flex items-center justify-center ${overlayPaddingClassName}`}
      >
        <div className="fixed inset-0" aria-hidden="true" onClick={handleBackdropClick} />
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          className={`relative ${surfaceClassName} rounded-lg shadow-xl w-full ${maxHeightClassName} overflow-hidden flex flex-col ${maxWidthClassName} ${panelClassName}`}
        >
          {typeof children === 'function' ? children({ requestClose }) : children}
        </div>
        <ConfirmDialog
          isOpen={discardAsked && isDirty}
          // Same layer as the modal: the dialog is portalled to <body> after the
          // modal, so at an equal z-index it paints above it (also for a modal
          // raised above z-50).
          zIndexClassName={zIndexClassName}
          title={t('common.discardDialog.title', 'Discard changes?')}
          message={
            dirtyTitle
              ? t('common.discardDialog.bodyNamed', {
                  title: dirtyTitle,
                  defaultValue: 'What you entered in "{{title}}" will be lost.'
                })
              : t('common.discardDialog.body', 'What you entered will be lost.')
          }
          denyLabel={t('common.discardDialog.keepEditing', 'Keep editing')}
          confirmLabel={t('common.discardDialog.discard', 'Discard')}
          danger
          onDeny={() => setDiscardAsked(false)}
          onConfirm={() => {
            setDiscardAsked(false);
            onClose();
          }}
        />
      </div>
    </OverlayOwner>
  );
}

export default Modal;
