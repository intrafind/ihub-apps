// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/** The nearest ancestor that clips its content (a scrolling message list), or null for the viewport. */
function clippingAncestor(node) {
  for (let el = node?.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = window.getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') return el;
  }
  return null;
}

/**
 * The disclosure behind a button that opens a small non-modal panel (the
 * "AI generated" details of an image, "About this answer" under an answer):
 *
 *  - the caller's button carries `aria-expanded` and `aria-controls={panelId}`,
 *  - Escape closes it and returns the focus to the button,
 *  - a press outside closes it,
 *  - it opens on the preferred side when it fits there inside the clipping
 *    container (or the viewport), else on the other side, and is capped to the
 *    room it has (it scrolls) when neither side fits: an answer at the top of
 *    the chat would otherwise cut the panel off and hide its first rows,
 *  - it slides sideways to stay inside the pane: a button that is not at the
 *    pane's edge (a chip beside another) would otherwise push the panel out of
 *    a narrow taskpane.
 *
 * @param {'top'|'bottom'} [placement='top'] - Where the panel prefers to open
 * @returns {{
 *   open: boolean,
 *   setOpen: Function,
 *   close: Function,
 *   side: 'top'|'bottom',
 *   maxHeight: number|null,
 *   panelStyle: Object|undefined,
 *   panelId: string,
 *   rootRef: Object,
 *   buttonRef: Object,
 *   panelRef: Object
 * }}
 */
export function usePopoverPanel(placement = 'top') {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();
  const [side, setSide] = useState(placement);
  const [maxHeight, setMaxHeight] = useState(null);
  const [shiftX, setShiftX] = useState(0);
  const shiftRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Measured before paint: open on the preferred side when the panel fits there
  // inside the clipping container (or the viewport), else on the other side.
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !buttonRef.current) return;
    const GAP = 8;
    // scrollHeight: the full content, also while an earlier cap is still applied.
    const height = panelRef.current.scrollHeight + GAP;
    const button = buttonRef.current.getBoundingClientRect();
    const clip = clippingAncestor(rootRef.current)?.getBoundingClientRect();
    const top = Math.max(clip ? clip.top : 0, 0);
    const bottom = Math.min(clip ? clip.bottom : window.innerHeight, window.innerHeight);
    const room = { top: button.top - top, bottom: bottom - button.bottom };
    const other = placement === 'bottom' ? 'top' : 'bottom';
    let next;
    if (room[placement] >= height) next = placement;
    else if (room[other] >= height) next = other;
    // Neither side fits: the roomier one, with the panel capped to it (it scrolls).
    else next = room.top > room.bottom ? 'top' : 'bottom';
    setSide(next);
    setMaxHeight(room[next] >= height ? null : Math.max(room[next] - GAP, 0));

    // Sideways: where the panel would sit without the shift it has now.
    const panel = panelRef.current.getBoundingClientRect();
    const left = Math.max(clip ? clip.left : 0, 0) + GAP;
    const right = Math.min(clip ? clip.right : window.innerWidth, window.innerWidth) - GAP;
    const natural = { left: panel.left - shiftRef.current, right: panel.right - shiftRef.current };
    let dx = 0;
    if (natural.right - natural.left >= right - left) dx = left - natural.left;
    else if (natural.left < left) dx = left - natural.left;
    else if (natural.right > right) dx = right - natural.right;
    shiftRef.current = dx;
    setShiftX(dx);
  }, [open, placement]);

  const panelStyle =
    maxHeight !== null || shiftX !== 0
      ? {
          ...(maxHeight !== null ? { maxHeight: `${maxHeight}px` } : {}),
          ...(shiftX !== 0 ? { transform: `translateX(${shiftX}px)` } : {})
        }
      : undefined;

  return {
    open,
    setOpen,
    close,
    side,
    maxHeight,
    panelStyle,
    panelId,
    rootRef,
    buttonRef,
    panelRef
  };
}

export default usePopoverPanel;
