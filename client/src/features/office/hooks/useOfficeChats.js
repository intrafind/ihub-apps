import { useMemo } from 'react';
import { useChatList } from '../../../shared/hooks/chatListStore';
import { officeChatsKey, resolveOfficeChats } from '../utilities/officeChatHistory';
import { officeLocale } from '../utilities/officeLocale';

/**
 * The pane user's stored chats that the pane can open, newest activity first.
 *
 * Served from the same store as the web app's chat list, so the start page and
 * the history page share one request and a finished turn in the chat panel
 * (which invalidates the store) refreshes both. Inert — no request, an empty
 * list — while `enabled` is false.
 *
 * @param {object} options
 * @param {object|null} options.user - The pane's signed-in user.
 * @param {boolean} options.enabled - Whether durable chats are on.
 * @param {object[]} options.apps - Apps the pane offers; chats of other apps are
 *   left out (see utilities/officeChatHistory.js).
 * @returns {{ rows: object[], loading: boolean, error: Error|null, hasMore: boolean,
 *   loadMore: () => Promise<void> }}
 */
export default function useOfficeChats({ user, enabled, apps }) {
  const { chats, loading, error, hasMore, loadMore } = useChatList(
    enabled ? officeChatsKey(user) : null,
    enabled
  );
  const rows = useMemo(() => resolveOfficeChats(chats, apps, officeLocale), [chats, apps]);
  return { rows, loading, error, hasMore, loadMore };
}
