// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useLayoutEffect } from 'react';

/**
 * Mark which product surface is on screen with `<html data-surface="…">`, for as long as the
 * calling component is mounted.
 *
 * CSS uses the attribute to scope surface-wide rules: `App.css` gives admin form fields a visible
 * boundary only under `[data-surface='admin']`, so end-user pages are never affected. It lives on
 * `<html>` rather than on a wrapper element so portalled dialogs and drawers, which render outside
 * the layout's DOM, are covered too.
 *
 * On unmount the previous value is restored (not blindly removed), so nested or StrictMode
 * double-mounted callers leave the document exactly as they found it. A subtree that must keep
 * the end-user look inside the admin (the test panel's chat) sets a plain `data-surface="app"`
 * attribute on its root element instead of calling this hook.
 *
 * Layout effect: the attribute is in place before the browser paints the surface, so its fields
 * never flash unstyled.
 *
 * @param {string} name - The surface name, e.g. `'admin'`.
 * @returns {void}
 *
 * @example
 * function AdminLayout() {
 *   useSurface('admin');
 *   return <Outlet />;
 * }
 */
export default function useSurface(name) {
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const html = document.documentElement;
    const previous = html.getAttribute('data-surface');
    html.setAttribute('data-surface', name);
    return () => {
      if (previous === null) {
        html.removeAttribute('data-surface');
      } else {
        html.setAttribute('data-surface', previous);
      }
    };
  }, [name]);
}
