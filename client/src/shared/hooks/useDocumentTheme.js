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
 * Unlike `useDarkMode`, which owns the preference and whose state is local to
 * each caller, this only reads what `applyThemeToDocument` put on `<html>`, so
 * every reader agrees with the switch wherever it was flipped.
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
