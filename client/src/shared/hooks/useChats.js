import { useAuth } from '../contexts/AuthContext';
import { usePlatformConfig } from '../contexts/PlatformConfigContext';
import useAuthKey from './useAuthKey';
import { useChatList } from './chatListStore';

// The list itself — cache, paging, invalidation — lives in `chatListStore`,
// which has no dependency on the web app's contexts. This module adds what the
// web app knows about the viewer.
export {
  CHATS_PAGE_SIZE,
  invalidateChatsCache,
  patchChatInCache,
  removeChatFromCache
} from './chatListStore';

/**
 * Whether durable chats are available **to the current viewer**.
 *
 * Two things have to be true. The platform has to be storing chats at all —
 * `chats.persistence` is resolved server-side from the feature flag, the
 * platform switch and a storage provider that actually came up, and an absent
 * `chats` block means a server too old to have stored anything. And the viewer
 * has to be a real, non-anonymous user: anonymous callers are never chat
 * owners (a fresh principal is minted per request), so for them the endpoints
 * only ever 401.
 *
 * This is the gate for every part of the history UI, not the retired
 * `chatHistoryPreview` flag.
 *
 * @returns {boolean}
 */
export function useChatPersistence() {
  const { platformConfig, isLoading } = usePlatformConfig();
  const { isAuthenticated } = useAuth();
  return !isLoading && platformConfig?.chats?.persistence === true && isAuthenticated === true;
}

/**
 * Whether the answer {@link useChatPersistence} is giving is still provisional.
 *
 * Both inputs resolve asynchronously, and until they have, the hook has to
 * answer `false` — it cannot claim a capability it has not confirmed. For a
 * list that is only a brief empty state, but a chat surface reads the same flag
 * to decide whether an empty transcript means "new chat" or "not fetched yet",
 * and answering "new chat" too early paints a greeting that the hydrated
 * history then replaces. Such a caller should hold its empty state back while
 * this is true.
 *
 * @returns {boolean}
 */
export function useChatPersistenceResolving() {
  const { isLoading: platformLoading } = usePlatformConfig();
  const { isLoading: authLoading } = useAuth();
  return platformLoading === true || authLoading === true;
}

/**
 * What the `/chats` route should render.
 *
 * The route cannot decide from {@link useChatPersistence} alone: that hook has
 * to answer `false` until the platform config *and* the auth status have both
 * landed, and the two are fetched independently, so "false" reads as "this
 * installation does not store chats" a beat before it becomes "you have 40 of
 * them". Gating on the platform config alone therefore paints the full-page
 * 404 at a signed-in user and swaps it for their chat list a moment later —
 * which is exactly what deciding inside the element was supposed to avoid.
 *
 * `resolving` already covers the platform config, so it is the only wait.
 *
 * @returns {'loading'|'unavailable'|'ready'}
 */
export function useChatHistoryRouteState() {
  const resolving = useChatPersistenceResolving();
  const persistence = useChatPersistence();
  if (resolving) return 'loading';
  return persistence ? 'ready' : 'unavailable';
}

/**
 * The current viewer's stored chats, newest activity first.
 *
 * Waits until authentication and the platform config have resolved (one
 * request instead of anonymous-then-authenticated), refetches when the viewer
 * changes, and stays in sync with every other consumer. Call
 * {@link invalidateChatsCache} after a send, a rename or a delete.
 *
 * When durable chats are unavailable to the viewer the hook does nothing at
 * all — no request, no error, an empty list that is not "loading". Calling the
 * endpoint anyway would 401 for an anonymous viewer, and the API client turns
 * a 401 into an `authTokenExpired` event that signs people out of the session
 * they are in.
 *
 * The chats come back exactly as stored: join `appId` against `useApps()` for
 * the app's name, colour and icon, and bucket `lastMessageAt` with
 * `utils/chatGroups`.
 *
 * @returns {{ chats: Object[], loading: boolean, error: Error|null, hasMore: boolean,
 *   loadMore: () => Promise<void> }}
 */
export default function useChats() {
  const key = useAuthKey();
  const persistence = useChatPersistence();
  return useChatList(key, !!key && persistence);
}
