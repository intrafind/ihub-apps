import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import * as authContext from '../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { fetchScheduledTaskNotifications, markScheduledTaskNotificationsSeen } from '../../../api';

export { useScheduledTaskLimits, useScheduledTasksEnabled } from './useScheduledTasksConfig';

/**
 * The auth state, or `{}` outside an AuthProvider. Falls back to `useAuth`
 * where only that is provided (module mocks in tests).
 */
function useViewerAuth() {
  if (typeof authContext.useOptionalAuth === 'function') return authContext.useOptionalAuth() || {};
  return authContext.useAuth?.() || {};
}

/**
 * Whether scheduled tasks are available to the current viewer: the server
 * says the feature is on (flag, durable chats and platform switch agree) and
 * the viewer is signed in.
 *
 * @returns {boolean}
 */
export function useScheduledTasksAvailable() {
  const { platformConfig, isLoading } = usePlatformConfig() || {};
  const { isAuthenticated } = useViewerAuth();
  return !isLoading && platformConfig?.scheduledTasks?.enabled === true && isAuthenticated === true;
}

/**
 * Whether the viewer may create (and run) tasks — the `scheduledTasks` group
 * permission. A user without it can still see, pause and delete tasks they
 * already own.
 *
 * @returns {boolean}
 */
export function useCanCreateScheduledTasks() {
  const { user } = useViewerAuth();
  return user?.permissions?.scheduledTasks === true;
}

/**
 * What the `/tasks` routes render: wait until both the platform config and the
 * auth status landed, so a signed-in user is not shown a 404 first.
 *
 * @returns {'loading'|'unavailable'|'ready'}
 */
export function useScheduledTasksRouteState() {
  const { isLoading: platformLoading } = usePlatformConfig() || {};
  const { isLoading: authLoading } = useViewerAuth();
  const available = useScheduledTasksAvailable();
  if (platformLoading || authLoading) return 'loading';
  return available ? 'ready' : 'unavailable';
}

// ── notifications: one shared store for the sidebar badge and the toast ──────

const POLL_MS = 60_000;
// `ownerId` is whose runs these are: the store outlives a sign-out in the same
// page, and the next account must never be shown the previous one's tasks.
let state = { items: [], loaded: false, ownerId: null };
let inflight = null;
let consumers = 0;
let timer = null;
const listeners = new Set();

const emit = () => listeners.forEach(listener => listener());
const subscribe = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/**
 * Start the store over for another viewer (or none), dropping what it held.
 *
 * @param {string|null} ownerId
 */
function switchOwner(ownerId) {
  if (state.ownerId === ownerId) return;
  state = { items: [], loaded: false, ownerId };
  inflight = null;
  emit();
}

/** Load the unseen runs now (shared by every consumer). */
export function refreshScheduledTaskNotifications() {
  if (inflight) return inflight;
  const ownerId = state.ownerId;
  const request = fetchScheduledTaskNotifications()
    .then(data => {
      // A sign-out while this was in flight: the answer is not the new viewer's.
      if (state.ownerId !== ownerId) return [];
      state = { items: Array.isArray(data?.items) ? data.items : [], loaded: true, ownerId };
      emit();
      return state.items;
    })
    .catch(() => (state.ownerId === ownerId ? state.items : []))
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** Drop runs from the shared list once they are seen, locally and on the server. */
export async function dismissScheduledTaskNotifications(runIds) {
  const ids = Array.isArray(runIds) ? new Set(runIds) : null;
  state = { ...state, items: ids ? state.items.filter(item => !ids.has(item.id)) : [] };
  emit();
  try {
    await markScheduledTaskNotificationsSeen(ids ? [...ids] : undefined);
  } catch {
    // The next refresh brings them back; nothing else to do.
  }
}

/**
 * The runs the viewer has not looked at yet, refreshed on a slow poll while
 * any consumer is mounted and the tab is visible.
 *
 * @returns {{items: Object[], count: number, loaded: boolean, refresh: Function}}
 */
export function useScheduledTaskNotifications() {
  const available = useScheduledTasksAvailable();
  const viewerId = useViewerAuth().user?.id ?? null;
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    switchOwner(available ? viewerId : null);
  }, [available, viewerId]);

  useEffect(() => {
    if (!available) return undefined;
    consumers += 1;
    if (consumers === 1) {
      refreshScheduledTaskNotifications();
      timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          refreshScheduledTaskNotifications();
        }
      }, POLL_MS);
    }
    return () => {
      consumers -= 1;
      if (consumers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [available, viewerId]);

  const refresh = useCallback(() => refreshScheduledTaskNotifications(), []);
  const items = available && current.ownerId === viewerId ? current.items : [];
  return { items, count: items.length, loaded: current.loaded, refresh };
}

/**
 * Re-render on an interval (for "in 5 minutes" labels).
 *
 * @param {number} [ms=30000]
 * @returns {number} now
 */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
