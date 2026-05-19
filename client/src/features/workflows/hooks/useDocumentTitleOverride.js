import { useEffect, useRef } from 'react';

/**
 * Temporarily overrides `document.title` while a component is mounted.
 *
 * On mount, captures the previous title to a ref and sets the new title.
 * On unmount, restores the captured title so the app-level `DocumentTitle`
 * component (which keys off the route) can take over again on the next route
 * change. Updates to `title` while mounted are applied immediately.
 *
 * The current title is read fresh on each mount, so navigating away and back
 * preserves correct restore behavior even if other code (e.g. `DocumentTitle`)
 * has updated `document.title` in between.
 *
 * @param {string|null|undefined} title - The title to display, or null/empty
 *   to skip and leave the existing title in place.
 */
export function useDocumentTitleOverride(title) {
  const previousRef = useRef(null);

  useEffect(() => {
    if (!title) return undefined;
    if (previousRef.current === null) {
      previousRef.current = document.title;
    }
    document.title = title;
    return () => {
      if (previousRef.current !== null) {
        document.title = previousRef.current;
        previousRef.current = null;
      }
    };
  }, [title]);
}

export default useDocumentTitleOverride;
