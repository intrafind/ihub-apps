// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';

/**
 * Shared overlay dialog primitive: backdrop, focus trap, Escape-to-close and
 * `aria-modal`. Renders nothing while closed so callers can keep an
 * `if (!data) return null;` guard above it for their own data dependencies.
 */
function Modal({
  isOpen,
  onClose,
  children,
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
  const containerRef = useRef(null);

  useFocusTrap(containerRef, {
    isActive: isOpen,
    initialFocusRef,
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={`fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full ${zIndexClassName} flex items-center justify-center ${overlayPaddingClassName}`}
    >
      <div
        className="fixed inset-0"
        aria-hidden="true"
        onClick={closeOnBackdropClick ? onClose : undefined}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative ${surfaceClassName} rounded-lg shadow-xl w-full ${maxHeightClassName} overflow-hidden flex flex-col ${maxWidthClassName} ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

export default Modal;
