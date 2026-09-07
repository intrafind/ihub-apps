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
  panelClassName = ''
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
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0"
        aria-hidden="true"
        onClick={closeOnBackdropClick ? onClose : undefined}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        className={`relative bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-h-[90vh] overflow-hidden flex flex-col ${maxWidthClassName} ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

export default Modal;
