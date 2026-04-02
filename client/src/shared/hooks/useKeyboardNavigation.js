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
 * receives `tabIndex=0` while all other items receive `tabIndex=-1`, and
 * `.focus()` is called on the active item so that screen readers announce it.
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

  /**
   * Keeps a mutable ref of the latest callbacks so the keydown handler
   * always calls the current versions without needing to be recreated.
   */
  const callbacksRef = useRef({ onSelect, onClose });
  useEffect(() => {
    callbacksRef.current = { onSelect, onClose };
  }, [onSelect, onClose]);

  /**
   * Applies the roving tabindex pattern: sets `tabIndex=0` on the item at
   * `index` and `tabIndex=-1` on all other navigable items in the container,
   * then calls `.focus()` on the active item.
   *
   * @param {HTMLElement[]} items - Array of navigable elements
   * @param {number} index - Index of the item to activate
   */
  const focusItem = useCallback((items, index) => {
    items.forEach((item, i) => {
      item.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    if (items[index]) {
      items[index].focus();
    }
  }, []);

  /**
   * Handles all keyboard events for navigation, selection, and dismissal.
   * The list of navigable items is queried fresh each time to account for
   * dynamic additions/removals.
   *
   * @param {KeyboardEvent} event - The keydown event
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
            // Clamp current index in case items were removed since last keypress
            const clamped = Math.min(current, items.length - 1);
            let next = clamped + 1;
            if (next >= items.length) {
              next = loop ? 0 : items.length - 1;
            }
            focusItem(items, next);
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
            focusItem(items, prev);
            return prev;
          });
          break;
        }

        case 'Home': {
          event.preventDefault();
          setActiveIndex(0);
          focusItem(items, 0);
          break;
        }

        case 'End': {
          event.preventDefault();
          const lastIndex = items.length - 1;
          setActiveIndex(lastIndex);
          focusItem(items, lastIndex);
          break;
        }

        case 'Enter': {
          event.preventDefault();
          if (callbacksRef.current.onSelect) {
            callbacksRef.current.onSelect(activeIndex);
          }
          break;
        }

        case ' ': {
          // Space — prevent default to avoid page scroll
          event.preventDefault();
          if (callbacksRef.current.onSelect) {
            callbacksRef.current.onSelect(activeIndex);
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
          // Let unhandled keys propagate normally
          break;
      }
    },
    [containerRef, orientation, loop, focusItem, activeIndex]
  );

  // Reset activeIndex to 0 when the hook is activated
  useEffect(() => {
    if (isActive) {
      setActiveIndex(0);
    }
  }, [isActive]);

  // Attach / detach the keydown listener and apply initial roving tabindex
  useEffect(() => {
    if (!isActive) return;

    const container = containerRef.current;
    if (!container) return;

    // Apply initial roving tabindex so the first item is tabbable
    const items = getNavigableElements(container);
    if (items.length > 0) {
      focusItem(items, 0);
    }

    // Use capture phase to ensure we intercept arrow keys before they cause scrolling
    container.addEventListener('keydown', handleKeyDown, true);

    return () => {
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isActive, containerRef, handleKeyDown, focusItem]);

  return { activeIndex, setActiveIndex };
}

export default useKeyboardNavigation;
