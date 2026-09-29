import { useEffect, useMemo, useRef } from 'react';
import { useChatList } from '../../../shared/hooks/chatListStore';
import { officeChatsKey, resolveOfficeChats } from '../utilities/officeChatHistory';
import { officeLocale } from '../utilities/officeLocale';

/**
 * Pages the hook may load on its own, per mount, to reach `minRows`. The
 * owner's chats are capped server-side, but a user whose recent chats are all
 * in apps the pane does not offer should not trigger a crawl of the whole list:
 * past this the page offers "Show older chats" instead.
 */
export const OFFICE_CHATS_AUTO_PAGES = 5;

/**
 * The pane user's stored chats that the pane can open, newest activity first.
 *
 * Served from the same store as the web app's chat list, so the start page and
 * the history page share one request and a finished turn in the chat panel
 * (which invalidates the store) refreshes both. Inert — no request, an empty
 * list — while `enabled` is false.
 *
 * Chats of apps the pane does not offer are left out, so a page from the server
 * can yield fewer rows than it holds — none at all for a user whose latest
 * chats are all in such apps. With `minRows`, the hook loads further pages on
 * its own until it has that many rows, the list is exhausted, a request fails,
 * or {@link OFFICE_CHATS_AUTO_PAGES} pages have been added.
 *
 * @param {object} options
 * @param {object|null} options.user - The pane's signed-in user.
 * @param {boolean} options.enabled - Whether durable chats are on.
 * @param {object[]} options.apps - Apps the pane offers; chats of other apps are
 *   left out (see utilities/officeChatHistory.js).
 * @param {boolean} [options.appsReady=true] - Whether `apps` has loaded. Until
 *   it has, every chat looks filtered out, so no page is fetched for it.
 * @param {number} [options.minRows=0] - Rows to page towards; 0 pages only when asked.
 * @returns {{ rows: object[], loading: boolean, error: Error|null, hasMore: boolean,
 *   loadMore: () => Promise<void> }}
 */
export default function useOfficeChats({ user, enabled, apps, appsReady = true, minRows = 0 }) {
  const { chats, loading, error, hasMore, loadMore } = useChatList(
    enabled ? officeChatsKey(user) : null,
    enabled
  );
  const rows = useMemo(() => resolveOfficeChats(chats, apps, officeLocale), [chats, apps]);

  const autoPagesRef = useRef(0);
  const pageOnward =
    enabled &&
    appsReady &&
    !loading &&
    !error &&
    hasMore &&
    rows.length < minRows &&
    autoPagesRef.current < OFFICE_CHATS_AUTO_PAGES;
  // Keyed on the list as well: a page that arrives quickly can have its
  // loading flag switched on and off within one render, so `pageOnward` alone
  // may never change between two pages and the next one would never be asked
  // for. Each arrived page is a new `chats`.
  useEffect(() => {
    if (!pageOnward) return;
    autoPagesRef.current += 1;
    loadMore();
  }, [pageOnward, loadMore, chats]);

  // Paging onward is loading too — without this the page would render the
  // short list as final for the frame between one page and the next.
  return { rows, loading: loading || pageOnward, error, hasMore, loadMore };
}
