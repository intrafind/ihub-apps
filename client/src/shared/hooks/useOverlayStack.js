// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Open overlays (Modal, ConfirmDialog, Drawer, SecretRevealDialog), in the
 * order they opened. The last entry is the topmost overlay.
 *
 * Each entry is `{ id, onEscapeRef }`. `onEscapeRef.current` is read when
 * Escape is pressed, so the handler can change between renders without the
 * overlay leaving and re-entering the stack (which would change its position).
 *
 * @type {Array<{ id: symbol, onEscapeRef: { current: ((event: KeyboardEvent) => void) | null } }>}
 */
const overlayStack = [];

/**
 * One window `keydown` listener serves every overlay: Escape goes to the
 * topmost overlay only (UX-N2). Before, each overlay listened on `window` by
 * itself, so a confirmation opened over a modal closed both on one Escape.
 *
 * An Escape another handler already consumed (`defaultPrevented`, e.g. a
 * listbox closing its popup or a Drawer that handled it) is left alone.
 *
 * @param {KeyboardEvent} event
 */
function handleWindowKeyDown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = overlayStack[overlayStack.length - 1];
  const onEscape = top?.onEscapeRef.current;
  if (!onEscape) return;
  event.preventDefault();
  onEscape(event);
}

/** Installs the shared listener while at least one overlay is open. */
function syncWindowListener() {
  if (typeof window === 'undefined') return;
  if (overlayStack.length > 0) {
    // addEventListener ignores a second registration of the same function.
    window.addEventListener('keydown', handleWindowKeyDown);
  } else {
    window.removeEventListener('keydown', handleWindowKeyDown);
  }
}

/**
 * useLayoutEffect in the browser, useEffect where there is no DOM, so the
 * stack is updated before any key event can reach the new overlay.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Registers an overlay in the shared overlay stack while it is open and
 * routes Escape to it only when it is the topmost overlay.
 *
 * Every overlay that closes on Escape uses this hook instead of its own
 * `window` listener. Overlays that handle Escape themselves (the Drawer,
 * which also manages Tab on `document`) pass no `onEscape` and use `isTop()`
 * to decide whether a key press is theirs.
 *
 * @param {boolean} isOpen - Whether the overlay is shown. The overlay joins the
 *   stack when this becomes true and leaves it when it becomes false or unmounts.
 * @param {(event: KeyboardEvent) => void} [onEscape] - Called when Escape is pressed
 *   while this overlay is the topmost one. Omit it (or pass null) to ignore Escape,
 *   e.g. while a dialog is busy; the overlay still blocks Escape from reaching
 *   the overlays below it.
 * @returns {{ isTop: () => boolean }} `isTop()` tells whether this overlay is
 *   currently the topmost one (false while closed).
 *
 * @example
 * function Modal({ isOpen, onClose }) {
 *   useOverlayStack(isOpen, onClose);
 *   …
 * }
 */
export function useOverlayStack(isOpen, onEscape) {
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = Symbol('overlay');
  const onEscapeRef = useRef(onEscape || null);
  onEscapeRef.current = onEscape || null;

  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return undefined;
    const entry = { id: idRef.current, onEscapeRef };
    overlayStack.push(entry);
    syncWindowListener();
    return () => {
      const index = overlayStack.indexOf(entry);
      if (index !== -1) overlayStack.splice(index, 1);
      syncWindowListener();
    };
  }, [isOpen]);

  const isTop = useCallback(
    () => overlayStack.length > 0 && overlayStack[overlayStack.length - 1].id === idRef.current,
    []
  );

  return { isTop };
}

/**
 * Number of open overlays. For tests only.
 *
 * @returns {number}
 */
export function getOpenOverlayCount() {
  return overlayStack.length;
}

export default useOverlayStack;
