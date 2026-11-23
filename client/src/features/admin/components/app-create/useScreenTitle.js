// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { setScreenTitle } from '../../../../shared/utils/screenTitle';

/**
 * Names the screen in the document title while the page is shown, in front of
 * the title of the area ("Check your draft | Admin | iHub"). A screen change
 * is then announced by its title as well as by its heading.
 *
 * The hook does not write the title itself: `DocumentTitle` does, and keeps
 * the screen's name when it rebuilds the title (the UI configuration arrived,
 * the language changed). Leaving the page takes the name out again.
 *
 * @param {string} heading - The heading of the current screen.
 */
export function useScreenTitle(heading) {
  useEffect(() => {
    setScreenTitle(heading);
  }, [heading]);
  useEffect(() => () => setScreenTitle(''), []);
}

export default useScreenTitle;
