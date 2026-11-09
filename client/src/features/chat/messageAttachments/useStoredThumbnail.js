// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';

/**
 * The thumbnail of a picture the server stored, for a card that has no picture in memory (a
 * chat opened again, a shared chat).
 *
 * The bytes are fetched through the app's own request (`fetchBlob`), not by pointing an `<img>`
 * at a URL: the request carries the credentials, and a bearer token kept in `localStorage` only
 * travels on a request the client makes itself. Reopening a chat mounts every card of every
 * message at once, so a card fetches only when it is close to the viewport, like a generated
 * image does.
 *
 * Nothing is shown (`src` stays `null`) while it loads and when it cannot be loaded: the card then
 * keeps its icon tile, which is also what a picture that has expired looks like.
 *
 * @param {Object} params
 * @param {{ current: Element|null }} params.ref - The element whose visibility starts the fetch.
 * @param {string|null} params.fileId - The stored file; `null`: nothing to fetch.
 * @param {((fileId: string) => Promise<Blob>)|null|undefined} params.fetchBlob - Absent: nothing
 *   to fetch with (no chat to read from).
 * @returns {{ src: string|null }}
 */
export function useStoredThumbnail({ ref, fileId, fetchBlob }) {
  const enabled = Boolean(fileId && fetchBlob);
  // Where IntersectionObserver does not exist (older browsers, tests) there is nothing to wait
  // for: the card counts as visible from the start instead of never.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [loaded, setLoaded] = useState({ fileId: null, src: null });

  useEffect(() => {
    if (!enabled || visible) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, visible, ref]);

  useEffect(() => {
    if (!enabled || !visible) return undefined;
    let active = true;
    let url = null;
    fetchBlob(fileId)
      .then(blob => {
        // Revoked in the cleanup below, once it has been handed to the element: revoking a URL
        // the browser has not loaded yet turns a slow render into a broken image.
        url = URL.createObjectURL(blob);
        if (active) setLoaded({ fileId, src: url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        // An expired, deleted or unshared picture: the card keeps its tile
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setLoaded({ fileId: null, src: null });
    };
  }, [enabled, visible, fileId, fetchBlob]);

  return { src: enabled && loaded.fileId === fileId ? loaded.src : null };
}
