// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** The width the list takes where there is room for it: six icons in a row. */
const WIDE_LIST_PX = 384;

/**
 * How the list is placed below its button. Six icons in a row need 24rem. A
 * narrower button gets a list of that width only where it stays inside what
 * clips the button (the page, or a dialog or column that scrolls): to the
 * right of the button's left edge, else to the left of its right edge.
 * Otherwise the list is as wide as the button, so that it never gives its
 * scroll container a sideways scroll range.
 *
 * @param {Element|null} trigger - The button.
 * @returns {'fit'|'wide-start'|'wide-end'}
 */
export function placeIconList(trigger) {
  if (!trigger) return 'fit';
  const rect = trigger.getBoundingClientRect();
  if (rect.width >= WIDE_LIST_PX) return 'fit';
  let left = 0;
  let right = document.documentElement.clientWidth;
  for (let node = trigger.parentElement; node; node = node.parentElement) {
    const overflow = window.getComputedStyle(node).overflowX;
    if (!overflow || overflow === 'visible') continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  if (rect.left + WIDE_LIST_PX <= right) return 'wide-start';
  if (rect.right - WIDE_LIST_PX >= left) return 'wide-end';
  return 'fit';
}
