// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';

/** Air between the bar and the control the browser scrolls into view, in pixels. */
const GAP = 8;

/**
 * Everything that can scroll the element: its ancestors with a scrolling
 * overflow, and the document (the window's scroller).
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement[]}
 */
function scrollContainersOf(element) {
  const root = document.documentElement;
  const found = [];
  for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') found.push(node);
  }
  found.push(root);
  return found;
}

/**
 * Keeps a bar that sticks to the bottom of its scroll area from covering the
 * control that has the keyboard focus (WCAG 2.2, 2.4.11 Focus Not Obscured).
 *
 * A browser scrolls a newly focused control just into view, to the bottom
 * edge, which is where the bar lies. While the bar is shown, its height is
 * therefore reserved as `scroll-padding-bottom` on everything that scrolls
 * it: the browser then stops above the bar. The height is measured, because
 * the bar wraps to several rows on a narrow window, and measured again when
 * the bar or the window changes size (the scroll area can be another one
 * then). What the containers had before comes back when the bar goes.
 *
 * @param {{ current: HTMLElement|null }} barRef - The bar.
 * @param {boolean} shown - The bar is rendered.
 */
export function useStickyBarSpace(barRef, shown) {
  useEffect(() => {
    const bar = barRef.current;
    if (!shown || !bar) return undefined;

    // What each container had before, to put it back.
    const before = new Map();
    const release = () => {
      for (const [node, value] of before) {
        if (value) node.style.setProperty('scroll-padding-bottom', value);
        else node.style.removeProperty('scroll-padding-bottom');
      }
      before.clear();
    };
    const reserve = () => {
      release();
      const space = `${Math.ceil(bar.getBoundingClientRect().height) + GAP}px`;
      for (const node of scrollContainersOf(bar)) {
        before.set(node, node.style.getPropertyValue('scroll-padding-bottom'));
        node.style.setProperty('scroll-padding-bottom', space);
      }
    };

    reserve();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reserve) : null;
    observer?.observe(bar);
    window.addEventListener('resize', reserve);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reserve);
      release();
    };
  }, [barRef, shown]);
}

export default useStickyBarSpace;
