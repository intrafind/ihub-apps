// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';

/** iHub's theme as the document root shows it right now. */
function readTheme() {
  if (typeof document === 'undefined') return 'light';
  const html = document.documentElement;
  return html.getAttribute('data-theme') === 'dark' || html.classList.contains('dark')
    ? 'dark'
    : 'light';
}

/**
 * The theme iHub currently shows, `'light'` or `'dark'`, kept current when the
 * user flips the dark-mode switch.
 *
 * `useDarkMode` reads the shared theme store; this reads only what is on
 * `<html>`, so it also sees themes applied outside the store (for example by
 * the Teams or Office integrations).
 *
 * @returns {'light'|'dark'}
 */
export default function useDocumentTheme() {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class']
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
