// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  createContext,
  createElement,
  useCallback,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

/**
 * One overlay in the React tree: `parent` is the overlay that renders it
 * (null for a top-level overlay). Set when the overlay joins the stack.
 *
 * @typedef {{ id: symbol, parent: (OverlayNode|null) }} OverlayNode
 */

/**
 * Open overlays (Modal, ConfirmDialog, Drawer, SecretRevealDialog), in the
 * order they opened. The last entry is the topmost overlay. An overlay
 * rendered inside another one always sits above it, even when both open in
 * the same render (see {@link insertEntry}).
 *
 * Each entry is `{ node, onEscapeRef }`. `onEscapeRef.current` is read when
 * Escape is pressed, so the handler can change between renders without the
 * overlay leaving and re-entering the stack (which would change its position).
 *
 * @type {Array<{ node: OverlayNode, onEscapeRef: { current: ((event: KeyboardEvent) => void) | null } }>}
 */
const overlayStack = [];

/**
 * The overlay that renders the current subtree. Overlay components wrap
 * their content in {@link OverlayOwner}, so an overlay nested in them knows
 * its owner even when it is portalled elsewhere in the DOM.
 */
const OverlayOwnerContext = createContext(null);

/**
 * Whether `node` is rendered (directly or further down) inside `ancestor`.
 *
 * @param {OverlayNode} node
 * @param {OverlayNode} ancestor
 * @returns {boolean}
 */
function isInside(node, ancestor) {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Adds an entry to the stack. Usually that is the top. But React runs the
 * layout effects of children before their parent's, so when a modal and a
 * confirmation inside it open in the same render, the confirmation registers
 * first: the owner then goes below the first entry that it renders.
 *
 * @param {{ node: OverlayNode }} entry
 */
function insertEntry(entry) {
  const firstOwned = overlayStack.findIndex(other => isInside(other.node, entry.node));
  if (firstOwned === -1) overlayStack.push(entry);
  else overlayStack.splice(firstOwned, 0, entry);
}

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
 * @returns {{ isTop: () => boolean, owner: OverlayNode }} `isTop()` tells whether
 *   this overlay is currently the topmost one (false while closed). `owner` is
 *   passed to {@link OverlayOwner} around the overlay's content, so overlays
 *   opened inside it stack above it.
 *
 * @example
 * function Modal({ isOpen, onClose, children }) {
 *   const { owner } = useOverlayStack(isOpen, onClose);
 *   return <OverlayOwner owner={owner}>{children}</OverlayOwner>;
 * }
 */
export function useOverlayStack(isOpen, onEscape) {
  const parent = use(OverlayOwnerContext);
  const [node] = useState(() => ({ id: Symbol('overlay'), parent: null }));
  const onEscapeRef = useRef(onEscape || null);

  // The handler is read on Escape; keep the ref current after every commit.
  useIsomorphicLayoutEffect(() => {
    onEscapeRef.current = onEscape || null;
  });

  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return undefined;
    node.parent = parent;
    const entry = { node, onEscapeRef };
    insertEntry(entry);
    syncWindowListener();
    return () => {
      const index = overlayStack.indexOf(entry);
      if (index !== -1) overlayStack.splice(index, 1);
      syncWindowListener();
    };
  }, [isOpen, node, parent]);

  const isTop = useCallback(
    () => overlayStack.length > 0 && overlayStack[overlayStack.length - 1].node === node,
    [node]
  );

  return { isTop, owner: node };
}

/**
 * Marks its children as rendered inside the overlay `owner`, so an overlay
 * among them (e.g. a confirmation in a modal) stacks above it.
 *
 * @param {Object} props
 * @param {OverlayNode} props.owner - `owner` from {@link useOverlayStack}.
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
export function OverlayOwner({ owner, children }) {
  return createElement(OverlayOwnerContext.Provider, { value: owner }, children);
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
