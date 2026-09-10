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

let cache = null; // { key, promise, chats, nextCursor, at }
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
      const chats = Array.isArray(data?.items) ? data.items : [];
      const nextCursor = data?.nextCursor || null;
      cache = { key, chats, nextCursor, at: Date.now(), promise: null };
      notify();
      return { chats, nextCursor };
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
    at: previous?.at ?? 0
  };
  return promise;
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
      cache = { key, chats, nextCursor, at: Date.now(), promise: null };
      notify();
      return { chats, nextCursor };
    })
    .finally(() => {
      if (morePromise === promise) morePromise = null;
    });
  morePromise = promise;
  return promise;
}

/** Drop the shared chat cache and make every mounted consumer refetch. */
export function invalidateChatsCache() {
  cache = null;
  morePromise = null;
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
