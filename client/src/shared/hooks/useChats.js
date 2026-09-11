import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChats } from '../../api';
import { useAuth } from '../contexts/AuthContext';
import { usePlatformConfig } from '../contexts/PlatformConfigContext';
import useAuthKey from './useAuthKey';

// The sidebar, the start page and the history page all need the same chat
// list, and the sidebar is mounted once in Layout for the whole session. One
// module-level store shares a single in-flight request per user and tells every
// mounted consumer when fresh data arrives, so three consumers cost one
// request — mirroring `useApps`, which solves the same problem for apps.
//
// The list is never served from the API-client cache (`fetchChats` passes no
// cache key): a chat list changes on every turn, and only this store decides
// how long a page may be reused.
const CACHE_TTL_MS = 30_000;

/** Page size asked for; matches the server's own default. */
export const CHATS_PAGE_SIZE = 30;

let cache = null; // { key, promise, chats, nextCursor, pages, at }
let morePromise = null; // in-flight `loadMore`, shared like the first page
const listeners = new Set();

const EMPTY_CHATS = Object.freeze([]);

/**
 * The state every consumer sees while durable chats are unavailable to this
 * viewer. A single frozen object, so switching to it is a no-op re-render.
 */
const IDLE = Object.freeze({
  chats: EMPTY_CHATS,
  loading: false,
  error: null,
  hasMore: false
});

const freshHit = key =>
  !!(cache && cache.key === key && cache.chats && Date.now() - cache.at < CACHE_TTL_MS);
const notify = () => listeners.forEach(listener => listener());

/**
 * Load (or reuse) the first page for one identity.
 *
 * @param {string} key - Auth key the page belongs to.
 * @returns {Promise<{ chats: Object[], nextCursor: string|null }>}
 */
function loadChats(key) {
  if (freshHit(key)) return Promise.resolve({ chats: cache.chats, nextCursor: cache.nextCursor });
  if (cache && cache.key === key && cache.promise) return cache.promise;
  const previous = cache && cache.key === key ? cache : null;
  const promise = fetchChats({ limit: CHATS_PAGE_SIZE })
    .then(data => {
      const head = Array.isArray(data?.items) ? data.items : [];
      const merged = mergeHead(head, data?.nextCursor || null, previous);
      cache = { key, ...merged, at: Date.now(), promise: null };
      notify();
      return { chats: merged.chats, nextCursor: merged.nextCursor };
    })
    .catch(error => {
      if (cache && cache.promise === promise) cache = previous;
      throw error;
    });
  cache = {
    key,
    promise,
    chats: previous?.chats ?? null,
    nextCursor: previous?.nextCursor ?? null,
    pages: previous?.pages ?? 1,
    at: previous?.at ?? 0
  };
  return promise;
}

/**
 * Fold a freshly read first page into the pages a consumer had already loaded.
 *
 * A refresh reads page one, because that is the only page whose cursor is
 * known without walking there. On a list that was never paged that is the whole
 * list and there is nothing to fold. On a list the user has paged through it is
 * the first 30 of several hundred rows, and taking it as the new list drops
 * everything below it: renaming a chat on `/chats` after scrolling for a while
 * used to snap the page back to thirty rows under the user's hands, with the
 * scroll position pointing at nothing.
 *
 * So the head is replaced and the tail is kept. A row the refresh moved up into
 * page one is dropped from the tail rather than shown twice, and the cursor
 * stays the one that describes the end of the accumulated list — page one's own
 * cursor would hand `loadMore` rows the user is already looking at.
 *
 * The tail is not re-read, so a chat renamed in another tab keeps its old title
 * down there until the list is loaded afresh. That is the cost, and it is the
 * smaller one: before this the tail did not go stale, it disappeared.
 *
 * @param {Object[]} head - The freshly read first page.
 * @param {string|null} headCursor - Cursor that follows the first page.
 * @param {Object|null} previous - The cache entry being refreshed, if any.
 * @returns {{chats: Object[], nextCursor: string|null, pages: number}}
 */
function mergeHead(head, headCursor, previous) {
  const pages = previous?.pages ?? 1;
  if (!previous?.chats || pages <= 1) return { chats: head, nextCursor: headCursor, pages: 1 };
  const seen = new Set(head.map(chat => chat?.id));
  const tail = previous.chats.filter(chat => chat?.id && !seen.has(chat.id));
  return { chats: head.concat(tail), nextCursor: previous.nextCursor, pages };
}

/**
 * Append the next cursor page to the shared list.
 *
 * @param {string} key - Auth key the page belongs to.
 * @returns {Promise<{ chats: Object[], nextCursor: string|null }|null>} null when there was
 *   nothing to append, or when the list moved under the request.
 */
function appendPage(key) {
  if (!cache || cache.key !== key || !cache.chats || !cache.nextCursor) {
    return Promise.resolve(null);
  }
  if (morePromise) return morePromise;
  const cursor = cache.nextCursor;
  const promise = fetchChats({ limit: CHATS_PAGE_SIZE, cursor })
    .then(data => {
      // A refresh (or an invalidate after a send) may have replaced the page
      // this cursor came from while the request was in flight. Appending onto
      // a list the cursor no longer describes would duplicate or interleave
      // rows, so drop the result and let the caller ask again.
      if (!cache || cache.key !== key || cache.nextCursor !== cursor) return null;
      const items = Array.isArray(data?.items) ? data.items : [];
      const seen = new Set(cache.chats.map(chat => chat.id));
      const chats = cache.chats.concat(items.filter(chat => chat?.id && !seen.has(chat.id)));
      const nextCursor = data?.nextCursor || null;
      // `at` moves with the append: the accumulated list is what consumers now
      // hold, and letting it expire would silently snap them back to page one.
      cache = {
        key,
        chats,
        nextCursor,
        pages: (cache.pages ?? 1) + 1,
        at: Date.now(),
        promise: null
      };
      notify();
      return { chats, nextCursor };
    })
    .finally(() => {
      if (morePromise === promise) morePromise = null;
    });
  morePromise = promise;
  return promise;
}

/**
 * Mark the shared chat cache stale so every mounted consumer refetches.
 *
 * Stale rather than gone, as long as somebody is looking at it. A rename or a
 * delete on a `/chats` the user has paged through used to replace several
 * hundred rows with the thirty of page one, under their hands and with the
 * scroll position left pointing at nothing. While a consumer is mounted the
 * rows it is rendering are kept and what the refetch reads is folded back in by
 * {@link mergeHead}.
 *
 * With no consumer mounted there is no list on screen to protect, so the entry
 * is dropped outright and the next mount starts from a clean page one.
 */
export function invalidateChatsCache() {
  cache = cache && listeners.size > 0 ? { ...cache, at: 0, promise: null } : null;
  morePromise = null;
  notify();
}

/**
 * Drop one chat from the shared list right now, before the server has been
 * asked.
 *
 * A delete that only invalidates leans entirely on the refetch that follows:
 * when that request fails the hook keeps the previous list, so the row the
 * user just deleted stays on screen — with no error to explain it, because the
 * DELETE itself succeeded. Answering locally first makes the outcome visible
 * whatever the refetch does; roll back with {@link invalidateChatsCache} if the
 * DELETE is the thing that failed.
 *
 * @param {string} chatId - Chat to remove.
 */
export function removeChatFromCache(chatId) {
  if (!cache?.chats || !chatId) return;
  const chats = cache.chats.filter(chat => chat?.id !== chatId);
  if (chats.length === cache.chats.length) return;
  cache = { ...cache, chats };
  notify();
}

/**
 * Merge fields into one chat of the shared list right now.
 *
 * Used for a rename, so every mounted consumer shows the new title on the same
 * frame instead of each surface keeping a private override that outlives — and
 * then masks — the stored value.
 *
 * @param {string} chatId - Chat to patch.
 * @param {Object} fields - Fields to merge into the stored document.
 */
export function patchChatInCache(chatId, fields) {
  if (!cache?.chats || !chatId || !fields) return;
  let changed = false;
  const chats = cache.chats.map(chat => {
    if (chat?.id !== chatId) return chat;
    changed = true;
    return { ...chat, ...fields };
  });
  if (!changed) return;
  cache = { ...cache, chats };
  notify();
}

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
 * State to start from, so a consumer that mounts onto a warm cache renders the
 * list on its first paint instead of flashing a spinner.
 *
 * @param {boolean} active - Whether the hook may talk to the API at all.
 * @param {string|null} key - Auth key.
 * @returns {{ chats: Object[], loading: boolean, error: Error|null, hasMore: boolean }}
 */
function initialState(active, key) {
  if (!active) return IDLE;
  if (freshHit(key)) {
    return { chats: cache.chats, loading: false, error: null, hasMore: !!cache.nextCursor };
  }
  return { chats: EMPTY_CHATS, loading: true, error: null, hasMore: false };
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
  const active = !!key && persistence;
  const [state, setState] = useState(() => initialState(active, key));

  // `loadMore` lives outside the load effect, so it needs its own liveness
  // flag; the effect keeps a local one as well, which additionally discards a
  // response that arrives after the viewer changed.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setState(prev => (prev === IDLE ? prev : IDLE));
      return undefined;
    }
    let mounted = true;
    const load = () => {
      setState(prev => (prev.loading ? prev : { ...prev, loading: true }));
      loadChats(key)
        .then(({ chats, nextCursor }) => {
          if (mounted) setState({ chats, loading: false, error: null, hasMore: !!nextCursor });
        })
        .catch(error => {
          if (mounted) setState(prev => ({ ...prev, loading: false, error }));
        });
    };
    const sync = () => {
      if (!mounted) return;
      if (freshHit(key)) {
        setState({
          chats: cache.chats,
          loading: false,
          error: null,
          hasMore: !!cache.nextCursor
        });
      } else {
        load();
      }
    };
    listeners.add(sync);
    sync();
    return () => {
      mounted = false;
      listeners.delete(sync);
    };
  }, [active, key]);

  const loadMore = useCallback(async () => {
    if (!active || !cache || cache.key !== key || !cache.nextCursor) return;
    setState(prev => (prev.loading ? prev : { ...prev, loading: true }));
    try {
      // A successful append notifies every consumer, this one included, which
      // is what clears `loading`. Nothing to append means clearing it here.
      const appended = await appendPage(key);
      if (!appended && mountedRef.current) {
        setState(prev => (prev.loading ? { ...prev, loading: false } : prev));
      }
    } catch (error) {
      if (mountedRef.current) setState(prev => ({ ...prev, loading: false, error }));
    }
  }, [active, key]);

  return useMemo(() => ({ ...state, loadMore }), [state, loadMore]);
}
