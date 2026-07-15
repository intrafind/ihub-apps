import { useCallback, useEffect, useRef, useState } from 'react';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { parseSseStream } from '../../../shared/utils/parseSseStream';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead } from '../../../api';

/**
 * Maintains the notification list + unread count for the current user,
 * fed by an initial REST fetch and then live-updated over SSE.
 *
 * Uses fetch + ReadableStream (not native EventSource) so the same
 * Authorization-header pattern as useEventSource.js works here too.
 */
export default function useNotifications({ enabled = true } = {}) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const abortControllerRef = useRef(null);

  const getAuthHeaders = useCallback(() => {
    const token = localStorage.getItem('authToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const loadInitial = useCallback(async () => {
    try {
      const result = await fetchNotifications({ limit: 50 });
      if (result) {
        setNotifications(result.notifications || []);
        setUnreadCount(result.unreadCount || 0);
      }
    } catch (err) {
      console.warn('Failed to load notifications:', err);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    loadInitial();

    const ac = new AbortController();
    abortControllerRef.current = ac;

    (async () => {
      try {
        const res = await fetch(buildApiUrl('notifications/stream'), {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...getAuthHeaders() },
          credentials: 'include',
          signal: ac.signal
        });
        if (!res.ok || !res.body) return;

        await parseSseStream(
          res.body,
          (name, data) => {
            if (name === 'notification' && data && data.id) {
              setNotifications(prev => [data, ...prev].slice(0, 50));
              setUnreadCount(prev => prev + 1);
            }
          },
          ac.signal
        );
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.warn('Notifications stream error:', err);
        }
      }
    })();

    return () => {
      ac.abort();
      abortControllerRef.current = null;
    };
  }, [enabled, getAuthHeaders, loadInitial]);

  const markRead = useCallback(async notificationId => {
    let wasUnread = false;
    setNotifications(prev =>
      prev.map(n => {
        if (n.id !== notificationId) return n;
        wasUnread = !n.read;
        return { ...n, read: true };
      })
    );
    if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await markNotificationRead(notificationId);
    } catch (err) {
      console.warn('Failed to mark notification as read:', err);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await markAllNotificationsRead();
    } catch (err) {
      console.warn('Failed to mark all notifications as read:', err);
    }
  }, []);

  return { notifications, unreadCount, markRead, markAllRead, refresh: loadInitial };
}
