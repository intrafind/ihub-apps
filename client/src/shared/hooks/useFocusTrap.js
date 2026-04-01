import { useEffect, useRef, useCallback } from 'react';

/**
 * Selector string for all natively focusable elements.
 * Covers interactive HTML elements plus elements with an explicit non-negative tabindex.
 * Elements with tabindex="-1" are excluded because they are programmatically
 * focusable but should not participate in the tab order.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * Queries all visible, focusable elements within a container.
 * Filters out elements that are hidden via CSS (display:none, visibility:hidden)
 * or have zero dimensions, since those cannot receive focus in practice.
 *
 * @param {HTMLElement} container - The DOM element to search within
 * @returns {HTMLElement[]} Array of focusable elements in DOM order
 */
function getFocusableElements(container) {
  if (!container) return [];
  const elements = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return elements.filter(el => {
    // Exclude elements hidden from the layout
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  });
}

/**
 * Custom hook that traps keyboard focus within a container element.
 *
 * When activated, the hook saves the currently focused element, moves focus into
 * the container, and intercepts Tab / Shift+Tab so focus cycles within the
 * container boundaries. When deactivated it optionally restores focus to the
 * previously focused element.
 *
 * Focusable elements are re-queried on every Tab press, so dynamically added or
 * removed elements are handled automatically without a MutationObserver.
 *
 * @param {React.RefObject<HTMLElement>} containerRef - Ref to the container that should trap focus
 * @param {Object} options - Configuration options
 * @param {boolean} options.isActive - Whether the focus trap is currently active
 * @param {React.RefObject<HTMLElement>} [options.initialFocusRef] - Ref to the element that should
 *   receive focus when the trap activates. Falls back to the first focusable element.
 * @param {boolean} [options.returnFocusOnDeactivate=true] - Whether to restore focus to the
 *   previously focused element when the trap deactivates
 *
 * @example
 * function Modal({ isOpen, onClose }) {
 *   const containerRef = useRef(null);
 *   const closeBtnRef = useRef(null);
 *
 *   useFocusTrap(containerRef, {
 *     isActive: isOpen,
 *     initialFocusRef: closeBtnRef,
 *     returnFocusOnDeactivate: true
 *   });
 *
 *   return (
 *     <div ref={containerRef} role="dialog" aria-modal="true">
 *       <button ref={closeBtnRef} onClick={onClose}>Close</button>
 *       <p>Modal content</p>
 *     </div>
 *   );
 * }
 */
export function useFocusTrap(
  containerRef,
  { isActive, initialFocusRef, returnFocusOnDeactivate = true }
) {
  /** Stores the element that had focus before the trap was activated. */
  const previousFocusRef = useRef(null);

  /**
   * Handles Tab and Shift+Tab key presses to keep focus cycling within the
   * container. Focusable elements are re-queried each time so that elements
   * added or removed after activation are included.
   *
   * @param {KeyboardEvent} event - The keydown event
   */
  const handleKeyDown = useCallback(
    event => {
      if (event.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        // No focusable elements — prevent Tab from leaving the container
        event.preventDefault();
        return;
      }

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (event.shiftKey) {
        // Shift+Tab: if on the first element, wrap to the last
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if on the last element, wrap to the first
        if (document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    },
    [containerRef]
  );

  useEffect(() => {
    if (!isActive) return;

    const container = containerRef.current;
    if (!container) return;

    // Save the element that currently holds focus so we can restore it later
    previousFocusRef.current = document.activeElement;

    // Move focus into the container
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      const focusable = getFocusableElements(container);
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    }

    // Attach the keydown listener to the container so it only fires when the
    // trap is active and focus is inside the container or its descendants.
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);

      // Restore focus to the element that was focused before activation
      if (returnFocusOnDeactivate && previousFocusRef.current) {
        // Use a microtask so the DOM has settled before we attempt to refocus.
        // This avoids race conditions when the container is unmounted at the
        // same time the trap is deactivated.
        const elementToRestore = previousFocusRef.current;
        previousFocusRef.current = null;
        queueMicrotask(() => {
          if (elementToRestore && typeof elementToRestore.focus === 'function') {
            elementToRestore.focus();
          }
        });
      }
    };
  }, [isActive, containerRef, initialFocusRef, returnFocusOnDeactivate, handleKeyDown]);
}

export default useFocusTrap;
