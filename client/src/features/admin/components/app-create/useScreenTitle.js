// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';

/**
 * Names the screen in the document title while the page is shown, in front of
 * the title the page had ("Check your draft | Admin | iHub"). A screen change
 * is then announced by its title as well as by its heading. Leaving the page
 * puts the previous title back.
 *
 * @param {string} heading - The heading of the current screen.
 */
export function useScreenTitle(heading) {
  useEffect(() => {
    const previous = document.title;
    document.title = previous ? `${heading} | ${previous}` : heading;
    return () => {
      document.title = previous;
    };
  }, [heading]);
}

export default useScreenTitle;
