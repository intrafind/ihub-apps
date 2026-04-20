import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Selector string for elements that can participate in keyboard navigation.
 * This covers interactive elements typically found in menus, listboxes, and
 * toolbar-like containers. ARIA role-based selectors are included so that
 * custom elements with explicit roles are navigable.
 */
const NAVIGABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]'
].join(', ');

/**
 * Queries all visible, navigable elements within a container.
 * Filters out elements that are hidden via CSS or have zero dimensions.
 *
 * @param {HTMLElement} container - The DOM element to search within
 * @returns {HTMLElement[]} Array of navigable elements in DOM order
 */
function getNavigableElements(container) {
  if (!container) return [];
  const elements = Array.from(container.querySelectorAll(NAVIGABLE_SELECTOR));
  return elements.filter(el => {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  });
}

/**
 * Custom hook for keyboard navigation within a container using the roving
 * tabindex pattern.
 *
 * Implements arrow-key navigation (vertical or horizontal), Home/End jumps,
 * Enter/Space selection, and Escape dismissal. The currently active item
 * receives `tabIndex=0` while all other items receive `tabIndex=-1`.
 *
 * The list of navigable items is re-queried on every key press, so
 * dynamically added or removed items are handled gracefully.
 *
 * @param {React.RefObject<HTMLElement>} containerRef - Ref to the container holding navigable items
 * @param {Object} options - Configuration options
 * @param {boolean} options.isActive - Whether keyboard navigation is currently active
 * @param {'vertical'|'horizontal'} [options.orientation='vertical'] - Axis of navigation.
 *   Vertical uses ArrowUp/ArrowDown; horizontal uses ArrowLeft/ArrowRight.
 * @param {Function} [options.onSelect] - Callback invoked with the active index when
 *   Enter or Space is pressed. Signature: `(activeIndex: number) => void`
 * @param {Function} [options.onClose] - Callback invoked when Escape is pressed.
 *   Signature: `() => void`
 * @param {boolean} [options.loop=true] - Whether navigation wraps around at boundaries
 * @returns {{ activeIndex: number, setActiveIndex: Function }}
 *
 * @example
 * function DropdownMenu({ isOpen, onClose, items, onItemSelect }) {
 *   const menuRef = useRef(null);
 *   const { activeIndex, setActiveIndex } = useKeyboardNavigation(menuRef, {
 *     isActive: isOpen,
 *     orientation: 'vertical',
 *     onSelect: (index) => onItemSelect(items[index]),
 *     onClose,
 *     loop: true
 *   });
 *
 *   return (
 *     <ul ref={menuRef} role="menu">
 *       {items.map((item, i) => (
 *         <li
 *           key={item.id}
 *           role="menuitem"
 *           tabIndex={i === activeIndex ? 0 : -1}
 *           onClick={() => onItemSelect(item)}
 *         >
 *           {item.label}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 */
export function useKeyboardNavigation(
  containerRef,
  { isActive, orientation = 'vertical', onSelect, onClose, loop = true }
) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Mutable ref that always holds the current activeIndex value.
  // The keydown handler reads from this ref so it never captures a stale
  // closure value and does not need to be recreated on every state change.
  const activeIndexRef = useRef(0);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  /**
   * Keeps a mutable ref of the latest callbacks so the keydown handler
   * always calls the current versions without needing to be recreated.
   */
  const callbacksRef = useRef({ onSelect, onClose });
  useEffect(() => {
    callbacksRef.current = { onSelect, onClose };
  }, [onSelect, onClose]);

  // Reset activeIndex to 0 when the hook is activated
  useEffect(() => {
    if (isActive) {
      setActiveIndex(0);
      activeIndexRef.current = 0;
    }
  }, [isActive]);

  // After activeIndex changes (or on initial activation), apply the roving
  // tabindex and move focus. Running this in an effect (rather than inside
  // the keydown handler) ensures React has already committed the new tabIndex
  // props to the DOM before we call .focus(), preventing the race between
  // imperative DOM mutations and React reconciliation.
  useEffect(() => {
    if (!isActive) return;
    const container = containerRef.current;
    if (!container) return;
    const items = getNavigableElements(container);
    if (items.length === 0) return;
    const clamped = Math.min(activeIndex, items.length - 1);
    items.forEach((item, i) => {
      item.setAttribute('tabindex', i === clamped ? '0' : '-1');
    });
    if (items[clamped]) {
      items[clamped].focus();
    }
  }, [isActive, activeIndex, containerRef]);

  /**
   * Handles all keyboard events for navigation, selection, and dismissal.
   *
   * This callback is intentionally stable (deps: containerRef, orientation,
   * loop — all refs/primitives that never change while the menu is open).
   * Stability prevents the listener-attachment effect from running on every
   * keypress, which was the root cause of arrow keys scrolling the container
   * instead of moving focus.
   */
  const handleKeyDown = useCallback(
    event => {
      const container = containerRef.current;
      if (!container) return;

      const items = getNavigableElements(container);
      if (items.length === 0) return;

      const isVertical = orientation === 'vertical';
      const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight';
      const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft';

      switch (event.key) {
        case nextKey: {
          event.preventDefault();
          setActiveIndex(current => {
            const clamped = Math.min(current, items.length - 1);
            let next = clamped + 1;
            if (next >= items.length) {
              next = loop ? 0 : items.length - 1;
            }
            return next;
          });
          break;
        }

        case prevKey: {
          event.preventDefault();
          setActiveIndex(current => {
            const clamped = Math.min(current, items.length - 1);
            let prev = clamped - 1;
            if (prev < 0) {
              prev = loop ? items.length - 1 : 0;
            }
            return prev;
          });
          break;
        }

        case 'Home': {
          event.preventDefault();
          setActiveIndex(0);
          break;
        }

        case 'End': {
          event.preventDefault();
          setActiveIndex(items.length - 1);
          break;
        }

        case 'Enter': {
          event.preventDefault();
          if (callbacksRef.current.onSelect) {
            callbacksRef.current.onSelect(activeIndexRef.current);
          }
          break;
        }

        case ' ': {
          event.preventDefault();
          if (callbacksRef.current.onSelect) {
            callbacksRef.current.onSelect(activeIndexRef.current);
          }
          break;
        }

        case 'Escape': {
          event.preventDefault();
          if (callbacksRef.current.onClose) {
            callbacksRef.current.onClose();
          }
          break;
        }

        default:
          break;
      }
    },
    [containerRef, orientation, loop]
  );

  // Attach / detach the keydown listener once when the menu opens/closes.
  // handleKeyDown is stable for the lifetime of the open menu, so this
  // effect only re-runs when isActive changes — not on every keypress.
  useEffect(() => {
    if (!isActive) return;

    const container = containerRef.current;
    if (!container) return;

    // Use capture phase to ensure we intercept arrow keys before they cause scrolling
    container.addEventListener('keydown', handleKeyDown, true);

    return () => {
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isActive, containerRef, handleKeyDown]);

  return { activeIndex, setActiveIndex };
}

export default useKeyboardNavigation;
