// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import useFocusTrap from './useFocusTrap';
import useMediaQuery from './useMediaQuery';

/**
 * The `lg` breakpoint of Tailwind: from here up the admin test panels sit
 * beside the page (`lg:static`), below it they cover it (`fixed inset-0`).
 */
export const PANEL_BESIDE_PAGE_QUERY = '(min-width: 64rem)';

/**
 * Keyboard behaviour of a side panel that covers the page on narrow screens
 * (WCAG 2.4.3): the admin test panels of an app, an integration and a project.
 *
 * Beside the page (from `lg` up) the panel is part of it: no dialog, no focus
 * taken, nothing intercepted. Covering the page it is a dialog: focus moves to
 * the close button and stays inside the panel, Escape closes it, and closing
 * (or growing the window past the breakpoint) gives focus back to the element
 * that opened it — so Tab can no longer reach editor controls hidden behind it.
 *
 * Escape is listened for on the element with `addEventListener`, as
 * `useFocusTrap` does for Tab, not with an `onKeyDown` on the JSX element: a
 * non-interactive element must not carry one
 * (jsx-a11y/no-noninteractive-element-interactions).
 *
 * @example
 * const { panelRef, closeRef, dialogProps } = useOverlayPanel({ onClose });
 * return (
 *   <aside ref={panelRef} aria-label={title} {...dialogProps} className="fixed inset-0 … lg:static …">
 *     <button ref={closeRef} onClick={onClose}>Close</button>
 *   </aside>
 * );
 *
 * @param {Object} options
 * @param {() => void} options.onClose - Closes the panel (Escape and the close button).
 * @returns {{
 *   panelRef: import('react').RefObject<HTMLElement|null>,
 *   closeRef: import('react').RefObject<HTMLElement|null>,
 *   overlay: boolean,
 *   dialogProps: {role?: 'dialog', 'aria-modal'?: true}
 * }} `panelRef` goes on the panel, `closeRef` on its close button, `dialogProps`
 *   is spread on the panel; `overlay` says whether it covers the page now.
 */
export default function useOverlayPanel({ onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const overlay = !useMediaQuery(PANEL_BESIDE_PAGE_QUERY);

  useFocusTrap(panelRef, { isActive: overlay, initialFocusRef: closeRef });

  useEffect(() => {
    const panel = panelRef.current;
    if (!overlay || !panel) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose();
    };
    panel.addEventListener('keydown', closeOnEscape);
    return () => panel.removeEventListener('keydown', closeOnEscape);
  }, [overlay, onClose]);

  return {
    panelRef,
    closeRef,
    overlay,
    dialogProps: overlay ? { role: 'dialog', 'aria-modal': true } : {}
  };
}
